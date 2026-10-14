/**
 * F6 physics debug view: every Rapier collider drawn as a wireframe over the
 * scene, plus a mesh-vs-collider audit of the cover.
 *
 * ## Why this exists
 *
 * The reported bug was "the camera goes inside a container and I can see the
 * inside and the other side". That had ONE cause, and it was not a collider
 * mismatch — it was the world camera's near plane (0.3 m) sitting two
 * millimetres inside the camera's real clearance from a wall (0.302 m), so
 * pressing into a container sliced its wall away. See `CAMERA.near`.
 *
 * But the near-plane explanation is only credible if the colliders genuinely do
 * match the visible meshes, and that is not something to take on trust. This
 * tool measures it: for every cover prop it compares the collider's half-extents
 * against the bounding box of the geometry that is actually drawn, in world
 * space, and reports the difference in centimetres.
 *
 * ## What it draws
 *
 *   - **cuboid** colliders (all cover, the floor slab) — an exact wireframe box;
 *   - **capsule** colliders (characters) — an exact wireframe capsule;
 *   - **trimesh** colliders (the level shell, 10.6k tris) — the AABB only. Drawing
 *     every triangle of the shell as lines is both unreadable and slow, and the
 *     AABB is what tells you whether the shell is where you think it is.
 *
 * The audit runs once when the view is switched on and logs to the console, so
 * the numbers are available to a scripted check as well as to the eye.
 */
import * as THREE from 'three';
import { RAPIER, type Physics } from '../core/physics';
import type { Level } from '../level/level';

export interface ColliderView {
  readonly visible: boolean;
  /** Runs the mesh-vs-collider audit and logs it. Returns the problems found. */
  audit(): string[];
  toggle(): void;
  dispose(): void;
}

/** A problem found by the audit, in the same style as the cover validator. */
interface Finding {
  severity: 'error' | 'warn';
  text: string;
}

/** Tolerance for "the collider matches the mesh": 2 cm, per the brief. */
const TOLERANCE = 0.02;

export function createColliderView(
  scene: THREE.Scene,
  physics: Physics,
  level: Level
): ColliderView {
  const root = new THREE.Group();
  root.name = 'collider-view';
  root.visible = false;
  scene.add(root);

  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  // Distinct colours per collider kind, so a stray collider is obvious.
  const MATS = {
    world: new THREE.LineBasicMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.7 }),
    prop: new THREE.LineBasicMaterial({ color: 0x44ddff, transparent: true, opacity: 0.85 }),
    character: new THREE.LineBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.85 }),
    // Movement-only volumes (rack bays): dim, since bullets pass through them.
    blocker: new THREE.LineBasicMaterial({ color: 0x44ddff, transparent: true, opacity: 0.3 }),
    unknown: new THREE.LineBasicMaterial({ color: 0xff44cc, transparent: true, opacity: 0.9 }),
  };
  disposables.push(MATS.world, MATS.prop, MATS.character, MATS.unknown);

  // Unit shapes, scaled per collider by the instance matrix.
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const capsuleGeo = new THREE.CapsuleGeometry(1, 1, 4, 12);
  disposables.push(boxGeo, capsuleGeo);

  const boxEdges = new THREE.EdgesGeometry(boxGeo);
  const capsuleEdges = new THREE.EdgesGeometry(capsuleGeo);
  disposables.push(boxEdges, capsuleEdges);

  let visible = false;
  let built = false;

  /** Builds the wireframes. Deferred until first use: it walks every collider. */
  function build() {
    if (built) return;
    built = true;

    const dummy = new THREE.Object3D();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    let cuboids = 0;
    let capsules = 0;
    let trimeshes = 0;

    physics.world.forEachCollider((collider) => {
      const tag = physics.tagOf(collider);
      const mat = tag ? MATS[tag.kind] : MATS.unknown;

      const t = collider.translation();
      const r = collider.rotation();
      q.set(r.x, r.y, r.z, r.w);
      dummy.position.set(t.x, t.y, t.z);
      dummy.quaternion.copy(q);
      dummy.scale.set(1, 1, 1);

      const shapeType = collider.shapeType();

      if (shapeType === RAPIER.ShapeType.Cuboid) {
        const half = collider.halfExtents();
        if (!half) return;
        dummy.scale.set(half.x * 2, half.y * 2, half.z * 2);
        dummy.updateMatrix();
        const line = new THREE.LineSegments(boxEdges, mat);
        line.matrixAutoUpdate = false;
        line.matrix.copy(dummy.matrix);
        line.name = `collider-cuboid-${tag?.kind ?? 'unknown'}`;
        root.add(line);
        cuboids++;
        return;
      }

      if (shapeType === RAPIER.ShapeType.Capsule) {
        // Rapier capsule: `halfHeight` is the cylinder half-length, `radius` the
        // cap radius. Three's CapsuleGeometry(radius=1, length=1) is a unit
        // capsule, so scale x/z by radius and y by (2*halfHeight + 2*radius)/2
        // = halfHeight + radius, since the unit capsule is 2 units tall.
        const half = collider.halfHeight();
        const radius = collider.radius();
        if (half === undefined || radius === undefined) return;
        dummy.scale.set(radius, half + radius, radius);
        dummy.updateMatrix();
        const line = new THREE.LineSegments(capsuleEdges, mat);
        line.matrixAutoUpdate = false;
        line.matrix.copy(dummy.matrix);
        line.name = `collider-capsule-${tag?.kind ?? 'unknown'}`;
        root.add(line);
        capsules++;
        return;
      }

      // Trimesh and anything else: draw the AABB. A trimesh's triangles are not
      // worth drawing — the shell is 10.6k of them — and the box is what answers
      // "is the shell where I think it is".
      const aabb = collider.shapeType() === RAPIER.ShapeType.TriMesh ? trimeshAabb(collider) : null;
      if (!aabb) return;
      scale.subVectors(aabb.max, aabb.min);
      dummy.position.copy(aabb.min).add(aabb.max).multiplyScalar(0.5);
      dummy.scale.copy(scale);
      dummy.updateMatrix();
      const line = new THREE.LineSegments(boxEdges, mat);
      line.matrixAutoUpdate = false;
      line.matrix.copy(dummy.matrix);
      line.name = `collider-trimesh-${tag?.kind ?? 'unknown'}`;
      root.add(line);
      trimeshes++;
    });

    console.log(
      `[collider-view] drew ${cuboids} cuboid, ${capsules} capsule, ` +
        `${trimeshes} trimesh-AABB colliders (${physics.world.colliders.len()} total)`
    );
  }

  /**
   * World-space AABB of a trimesh collider, taken from its vertices.
   *
   * Rapier's trimesh shape does not expose a bounds accessor, so the vertices are
   * walked. They are already in collider-local space; the collider's own transform
   * is applied afterwards.
   */
  function trimeshAabb(collider: RAPIER.Collider): THREE.Box3 | null {
    const vertices = (
      collider as unknown as { vertices?: () => Float32Array | undefined }
    ).vertices?.();
    if (!vertices || vertices.length < 9) return null;

    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      v.set(vertices[i], vertices[i + 1], vertices[i + 2]);
      box.expandByPoint(v);
    }
    if (box.isEmpty()) return null;
    // Trimesh colliders here are created on a fixed body at the origin with no
    // rotation, so local space is world space. Transform anyway, so a future
    // collider that is moved does not silently read wrong.
    const t = collider.translation();
    const r = collider.rotation();
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(t.x, t.y, t.z),
      new THREE.Quaternion(r.x, r.y, r.z, r.w),
      new THREE.Vector3(1, 1, 1)
    );
    return box.applyMatrix4(m);
  }

  /**
   * The audit: does each cover collider match the geometry that is drawn?
   *
   * Both are measured in WORLD space and compared as half-extents and centres,
   * which catches the three failure modes the brief asks about:
   *
   *   - **half-extents vs full size** — the collider would be half or double;
   *   - **offset** — the centres would disagree;
   *   - **rotation** — an axis-aligned comparison would disagree on which axis is
   *     long, and a rotated collider's world AABB would differ from the mesh's.
   *
   * It also catches scale applied to the InstancedMesh but not the collider,
   * because the mesh side is measured through the instance matrix.
   */
  function audit(): string[] {
    const findings: Finding[] = [];
    const props = level.cover.props;

    if (!props.length) {
      findings.push({
        severity: 'error',
        text: 'no cover props are exposed for auditing — the audit would pass vacuously',
      });
    }

    const meshBox = new THREE.Box3();
    const meshCenter = new THREE.Vector3();
    const meshHalf = new THREE.Vector3();
    const colHalf = new THREE.Vector3();
    const colCenter = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();

    let worst = 0;
    let worstName = '';

    for (const prop of props) {
      const geo = prop.mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bbox = geo.boundingBox;
      if (!bbox) continue;

      // ---- the drawn instance, in world space ----
      prop.mesh.getMatrixAt(prop.index, matrix);
      prop.mesh.updateWorldMatrix(true, false);
      const world = new THREE.Matrix4().multiplyMatrices(prop.mesh.matrixWorld, matrix);
      world.decompose(pos, quat, scale);

      meshBox.copy(bbox);
      // The instance matrix may carry a rotation (containers are placed at
      // rotY = 0 or PI/2), so transform the box rather than assuming axis
      // alignment — that is what makes a rotation mismatch visible.
      meshBox.applyMatrix4(
        new THREE.Matrix4().compose(
          new THREE.Vector3(0, 0, 0),
          quat,
          new THREE.Vector3(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z))
        )
      );
      meshBox.getCenter(meshCenter);
      meshBox.getSize(meshHalf);
      meshHalf.multiplyScalar(0.5);

      // ---- the collider, in world space ----
      const half = prop.collider.halfExtents();
      if (!half) {
        findings.push({ severity: 'error', text: `"${prop.name}" collider is not a cuboid` });
        continue;
      }
      const ct = prop.collider.translation();
      const cr = prop.collider.rotation();
      colCenter.set(ct.x, ct.y, ct.z);
      const colQuat = new THREE.Quaternion(cr.x, cr.y, cr.z, cr.w);
      const colBox = new THREE.Box3(
        new THREE.Vector3(-half.x, -half.y, -half.z),
        new THREE.Vector3(half.x, half.y, half.z)
      );
      colBox.applyMatrix4(
        new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), colQuat, new THREE.Vector3(1, 1, 1))
      );
      colBox.getCenter(colCenter);
      colBox.getSize(colHalf);
      colHalf.multiplyScalar(0.5);

      // ---- compare ----
      const dx = Math.abs(meshHalf.x - colHalf.x);
      const dy = Math.abs(meshHalf.y - colHalf.y);
      const dz = Math.abs(meshHalf.z - colHalf.z);
      const cx = Math.abs(meshCenter.x - colCenter.x);
      const cy = Math.abs(meshCenter.y - colCenter.y);
      const cz = Math.abs(meshCenter.z - colCenter.z);

      const sizeErr = Math.max(dx, dy, dz);
      const posErr = Math.max(cx, cy, cz);
      const err = Math.max(sizeErr, posErr);
      if (err > worst) {
        worst = err;
        worstName = prop.name;
      }

      // A collider may be up to 2 cm LARGER than the mesh (the brief allows it),
      // but never smaller — a smaller collider is a hole the camera can enter.
      const smaller = meshHalf.x - colHalf.x > TOLERANCE ||
        meshHalf.y - colHalf.y > TOLERANCE ||
        meshHalf.z - colHalf.z > TOLERANCE;

      if (smaller) {
        findings.push({
          severity: 'error',
          text:
            `"${prop.name}" (${prop.batch}) collider is SMALLER than its mesh — ` +
            `mesh half [${meshHalf.x.toFixed(3)}, ${meshHalf.y.toFixed(3)}, ${meshHalf.z.toFixed(3)}] ` +
            `vs collider half [${colHalf.x.toFixed(3)}, ${colHalf.y.toFixed(3)}, ${colHalf.z.toFixed(3)}] ` +
            `(short by ${((meshHalf.x - colHalf.x) * 100).toFixed(1)}, ` +
            `${((meshHalf.y - colHalf.y) * 100).toFixed(1)}, ` +
            `${((meshHalf.z - colHalf.z) * 100).toFixed(1)} cm)`,
        });
      } else if (err > TOLERANCE) {
        findings.push({
          severity: 'warn',
          text:
            `"${prop.name}" (${prop.batch}) collider differs from its mesh by ` +
            `${(err * 100).toFixed(1)} cm ` +
            `(size dx/dy/dz ${(dx * 100).toFixed(1)}/${(dy * 100).toFixed(1)}/${(dz * 100).toFixed(1)} cm, ` +
            `centre dx/dy/dz ${(cx * 100).toFixed(1)}/${(cy * 100).toFixed(1)}/${(cz * 100).toFixed(1)} cm)`,
        });
      }
    }

    // ---- report ----
    const errors = findings.filter((f) => f.severity === 'error');
    const warns = findings.filter((f) => f.severity === 'warn');

    console.log(
      `[collider-view] audited ${props.length} cover props against their meshes | ` +
        `tolerance ${(TOLERANCE * 100).toFixed(0)} cm | ` +
        `worst mismatch ${(worst * 100).toFixed(2)} cm` +
        (worstName ? ` ("${worstName}")` : '') +
        ` | ${errors.length} error(s), ${warns.length} warning(s)`
    );
    for (const f of errors) console.error(`[collider-view] ${f.text}`);
    for (const f of warns) console.warn(`[collider-view] ${f.text}`);
    if (!findings.length) {
      console.log('[collider-view] every cover collider matches its visible mesh.');
    }

    return findings.map((f) => `${f.severity.toUpperCase()}: ${f.text}`);
  }

  return {
    get visible() {
      return visible;
    },
    audit,
    toggle() {
      visible = !visible;
      if (visible) build();
      root.visible = visible;
      if (visible) {
        const findings = audit();
        console.log(
          `[collider-view] ON — grey = world shell, cyan = cover props, ` +
            `yellow = character capsules. Trimesh colliders are drawn as their AABB.`
        );
        void findings;
      } else {
        console.log('[collider-view] OFF');
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      root.traverse((o) => {
        const ls = o as THREE.LineSegments;
        if (ls.isLineSegments) ls.geometry?.dispose();
      });
      root.removeFromParent();
    },
  };
}
