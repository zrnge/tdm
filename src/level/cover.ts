/**
 * Warehouse cover: shipping containers, crate stacks and pallet racking.
 *
 * ## The hall
 *
 * 16.0 m wide (X, +/-8.0) x 46.27 m deep (Z, +/-23.135) x 5.02 m tall. The roof
 * is an ARCH: it peaks at 5.02 m on the centre line and falls to ~3.02 m where
 * it meets the walls. `tools/level-profile.mjs` measures it, and the numbers
 * matter — a 2.8 m pallet rack against a wall has only 0.22 m of headroom, and
 * there is a low obstruction around x = 3.5..4.0 where the roof is 2.91 m.
 * Every placement is therefore validated against the real roof by raycast
 * before it is created; see `validatePlacement()`.
 *
 * ## The layout
 *
 * Three lanes running the length of the hall, mirror-symmetrical about BOTH
 * the X and Z axes so neither team gets an advantage:
 *
 *     x = -8.0 .. -4.6   WEST FLANK LANE   low crates, crouch cover, gaps
 *     x = -4.6 .. -2.6   west divider      crate stacks
 *     x = -2.6 .. +2.6   CENTRE LANE       container spine, staggered cover
 *     x = +2.6 .. +4.6   east divider      crate stacks
 *     x = +4.6 .. +8.0   EAST FLANK LANE   low crates, crouch cover, gaps
 *
 * ## Sightline rule
 *
 * There must be NO clear line of sight between the two spawn centres. Two
 * crosswise containers form a hard wall in front of each spawn (z = -/+10.8),
 * and the centre line x = 0 is blocked by both of them. The flank lanes are
 * broken twice each by lengthwise containers at z = -/+5.0, so a route down a
 * flank has to pass the mid-hall gap at z = 0. `validateSightlines()` proves it
 * with a raycast, and the F3 overlay draws the line in red if it ever becomes
 * clear.
 *
 * ## Stacking
 *
 * The brief asks for stacked shipping containers. A true double stack is
 * 2 x 2.59 = 5.18 m, which does NOT fit under the 5.02 m ceiling, so containers
 * stay single height and the stacked silhouette comes from two-high crate
 * stacks beside them. `validatePlacement()` would reject a double stack anyway.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COVER } from '../config';
import { RAPIER, type Physics } from '../core/physics';
import { applyWeathering } from './weathering';

export interface Cover {
  root: THREE.Group;
  /** Every collider created for cover, for debugging and navmesh excludes. */
  colliders: RAPIER.Collider[];
  /**
   * Collider-to-mesh pairing, one entry per placed prop.
   *
   * Each entry records the InstancedMesh instance a collider was built
   * alongside, so the F6 tool can measure the collider against the geometry that
   * is actually drawn instead of trusting that the two agree. That trust is
   * exactly what the "camera inside the container" bug was made of.
   */
  props: CoverProp[];
  /** Problems found by the clearance validator. Empty when the layout is clean. */
  problems: string[];
  /** World-space points the F3 overlay uses for its sightline test. */
  sightline: { from: THREE.Vector3; to: THREE.Vector3 };
  dispose(): void;
}

/** One placed prop: the instance that draws it and the collider that stops you. */
export interface CoverProp {
  /** Placement name from the layout tables, e.g. "spine-west". */
  name: string;
  /** Batch this prop belongs to, e.g. "cover-containers-long". */
  batch: string;
  mesh: THREE.InstancedMesh;
  /** Index of this prop's instance within `mesh`. */
  index: number;
  collider: RAPIER.Collider;
  /** The half-extents the collider was built from. */
  half: HalfExtents;
}

interface Placement {
  /** For logging. */
  name: string;
  x: number;
  /** Base height; > 0 for the upper crate of a stack. */
  y: number;
  z: number;
  /** Radians. 0 or PI/2 only — the colliders are exact cuboids. */
  rotY: number;
}

/** Context the validator needs from the level. */
export interface CoverContext {
  /** Structural meshes, raycast for the roof/wall clearance check. */
  structural: THREE.Mesh[];
  /** Zones cover must never overlap. */
  spawnZones: { center: THREE.Vector3; half: THREE.Vector3 }[];
  /** Interior half-extents, metres. */
  halfX: number;
  halfZ: number;
  /** Interior height at the centre line, metres. */
  height: number;
}

const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Crosswise containers: 6.06 m along X, 2.44 m along Z.
 *
 * These are the spawn walls. They sit 2.2 m beyond the spawn zone edge, span
 * x = -3.03 .. +3.03, and block the centre line completely — which is what
 * makes the spawn-to-spawn sightline impossible.
 */
const CONTAINERS_CROSS: Placement[] = [
  { name: 'spawn-wall-blue', x: 0, y: 0, z: -10.8, rotY: 0 },
  { name: 'spawn-wall-red', x: 0, y: 0, z: 10.8, rotY: 0 },
];

/**
 * Lengthwise containers: 2.44 m along X, 6.06 m along Z.
 *
 * The spine pair leaves a deliberate 1.36 m chokepoint on the centre line. The
 * four flank blockers are what break the flank sightlines: each lane is
 * blocked from z = -8.03 to -1.97 and again from +1.97 to +8.03, so the only way
 * down a flank is through the mid-hall gap at z = 0.
 */
const CONTAINERS_LONG: Placement[] = [
  { name: 'spine-west', x: -1.9, y: 0, z: 0, rotY: HALF_PI },
  { name: 'spine-east', x: 1.9, y: 0, z: 0, rotY: HALF_PI },
  { name: 'flank-block-west-blue', x: -6.1, y: 0, z: -5.0, rotY: HALF_PI },
  { name: 'flank-block-west-red', x: -6.1, y: 0, z: 5.0, rotY: HALF_PI },
  { name: 'flank-block-east-blue', x: 6.1, y: 0, z: -5.0, rotY: HALF_PI },
  { name: 'flank-block-east-red', x: 6.1, y: 0, z: 5.0, rotY: HALF_PI },
];

/**
 * Pallet racking. 2.8 m tall, so it needs 2.95 m of roof: placed at x = +/-5.0
 * where the roof is 4.14 m, NOT against the walls where it drops to 3.02 m and
 * would leave only 0.22 m.
 *
 * z = +/-11.5 is the only slot that clears everything: the spawn zone ends at
 * z = -/+13.2, the two-high crates beside it start at z = -/+9.4, and the
 * crosswise spawn-wall container occupies x = -3.03..3.03 so there is no x
 * overlap with a rack at x = +/-5.0. The validator checks all three.
 */
const RACKS: Placement[] = [
  { name: 'rack-west-blue', x: -5.0, y: 0, z: -11.5, rotY: 0 },
  { name: 'rack-west-red', x: -5.0, y: 0, z: 11.5, rotY: 0 },
  { name: 'rack-east-blue', x: 5.0, y: 0, z: -11.5, rotY: 0 },
  { name: 'rack-east-red', x: 5.0, y: 0, z: 11.5, rotY: 0 },
];

/**
 * Crates. `y: 1.2` entries are the upper crate of a two-high stack.
 *
 * Crouch cover in the flank lanes is deliberately single height (1.2 m): it
 * hides a crouched player but can be shot over standing, which is what keeps
 * the flanks fast rather than safe.
 */
const CRATES: Placement[] = [
  // Flank-lane crouch cover, outboard of the flank blockers.
  { name: 'flank-crate-w-blue', x: -6.9, y: 0, z: -11.0, rotY: 0 },
  { name: 'flank-crate-w-red', x: -6.9, y: 0, z: 11.0, rotY: 0 },
  { name: 'flank-crate-e-blue', x: 6.9, y: 0, z: -11.0, rotY: 0 },
  { name: 'flank-crate-e-red', x: 6.9, y: 0, z: 11.0, rotY: 0 },

  // Flank chokepoint cover, in the mid-hall gap the flank blockers force you
  // through. Single height, so it is cover to crouch behind, not a wall.
  { name: 'flank-crate-w-mid', x: -6.1, y: 0, z: 0, rotY: 0 },
  { name: 'flank-crate-e-mid', x: 6.1, y: 0, z: 0, rotY: 0 },

  // Two-high stacks flanking the central spine — the "stacked" silhouette.
  { name: 'stack-w-blue-0', x: -3.9, y: 0, z: -3.0, rotY: 0 },
  { name: 'stack-w-blue-1', x: -3.9, y: 1.2, z: -3.0, rotY: 0 },
  { name: 'stack-w-red-0', x: -3.9, y: 0, z: 3.0, rotY: 0 },
  { name: 'stack-w-red-1', x: -3.9, y: 1.2, z: 3.0, rotY: 0 },
  { name: 'stack-e-blue-0', x: 3.9, y: 0, z: -3.0, rotY: 0 },
  { name: 'stack-e-blue-1', x: 3.9, y: 1.2, z: -3.0, rotY: 0 },
  { name: 'stack-e-red-0', x: 3.9, y: 0, z: 3.0, rotY: 0 },
  { name: 'stack-e-red-1', x: 3.9, y: 1.2, z: 3.0, rotY: 0 },

  // Two-high stacks just outside each spawn wall, screening the flank exits.
  { name: 'stack-nw-blue-0', x: -4.9, y: 0, z: -8.8, rotY: 0 },
  { name: 'stack-nw-blue-1', x: -4.9, y: 1.2, z: -8.8, rotY: 0 },
  { name: 'stack-nw-red-0', x: -4.9, y: 0, z: 8.8, rotY: 0 },
  { name: 'stack-nw-red-1', x: -4.9, y: 1.2, z: 8.8, rotY: 0 },
  { name: 'stack-ne-blue-0', x: 4.9, y: 0, z: -8.8, rotY: 0 },
  { name: 'stack-ne-blue-1', x: 4.9, y: 1.2, z: -8.8, rotY: 0 },
  { name: 'stack-ne-red-0', x: 4.9, y: 0, z: 8.8, rotY: 0 },
  { name: 'stack-ne-red-1', x: 4.9, y: 1.2, z: 8.8, rotY: 0 },

  // Centre-lane cover, either side of the spine.
  { name: 'centre-crate-blue', x: 0, y: 0, z: -6.5, rotY: 0 },
  { name: 'centre-crate-red', x: 0, y: 0, z: 6.5, rotY: 0 },
];

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A shipping container: body plus corner posts and top/bottom rails. */
function containerGeometry(): THREE.BufferGeometry {
  const { x, y, z } = COVER.container;
  const parts: THREE.BufferGeometry[] = [];

  const push = (w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const b = new THREE.BoxGeometry(w, h, d);
    b.translate(px, py, pz);
    parts.push(b);
  };

  push(x, y, z, 0, 0, 0);
  push(x + RAIL_OVERHANG, 0.12, z + RAIL_OVERHANG, 0, y / 2 - 0.06, 0);
  push(x + RAIL_OVERHANG, 0.12, z + RAIL_OVERHANG, 0, -y / 2 + 0.06, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      push(0.14, y, 0.14, sx * (x / 2 - 0.07), 0, sz * (z / 2 - 0.07));
    }
  }
  return mergeGeometries(parts, false)!;
}

/**
 * How far the container's top and bottom rails stick out past its body, metres
 * PER SIDE.
 *
 * This exists as a named constant because getting it wrong is a silent 2 cm
 * hole. The rails are the outermost thing on a container, so they define its real
 * footprint — and the collider has to match the rails, not the body. The F6
 * collider audit caught exactly this: six lengthwise containers had colliders
 * built from `COVER.container` alone, 2 cm smaller than the mesh on both
 * horizontal axes.
 *
 * The body is `COVER.container` wide; the rails are `+ 2 * RAIL_OVERHANG` wide in
 * total, so the collider half-extent is `COVER.container.x / 2 + RAIL_OVERHANG`.
 */
const RAIL_OVERHANG = 0.02;

/** One solid piece of a prop, centred in the prop's own space. */
interface PartBox {
  /** Full size, metres. */
  size: [number, number, number];
  /** Centre, metres, relative to the prop's centre. */
  at: [number, number, number];
}

/**
 * A pallet racking bay: four uprights, three shelf decks and two top beams.
 *
 * The same list builds the mesh AND the bay's bullet colliders, so a round
 * stops exactly on the steel that is drawn and passes through the open bays.
 */
function rackParts(): PartBox[] {
  const { x, y, z } = COVER.rack;
  const parts: PartBox[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({ size: [0.09, y, 0.09], at: [sx * (x / 2 - 0.05), 0, sz * (z / 2 - 0.05)] });
    }
  }
  for (const deckY of [0.35, 1.35, 2.35]) parts.push({ size: [x, 0.05, z], at: [0, deckY - y / 2, 0] });
  for (const sz of [-1, 1]) parts.push({ size: [x, 0.09, 0.09], at: [0, y / 2 - 0.05, sz * (z / 2 - 0.05)] });
  return parts;
}

function rackGeometry(): THREE.BufferGeometry {
  const parts = rackParts().map(({ size, at }) => {
    const b = new THREE.BoxGeometry(...size);
    b.translate(...at);
    return b;
  });
  return mergeGeometries(parts, false)!;
}

/** A wooden pallet crate: a box with a raised rim so the edges read. */
function crateGeometry(): THREE.BufferGeometry {
  const { x, y, z } = COVER.crate;
  const parts: THREE.BufferGeometry[] = [];
  const push = (w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const b = new THREE.BoxGeometry(w, h, d);
    b.translate(px, py, pz);
    parts.push(b);
  };
  push(x * 0.94, y * 0.94, z * 0.94, 0, 0, 0);
  push(x, 0.08, z, 0, y / 2 - 0.04, 0);
  push(x, 0.08, z, 0, -y / 2 + 0.04, 0);
  return mergeGeometries(parts, false)!;
}

// ---------------------------------------------------------------------------
// Clearance validation
// ---------------------------------------------------------------------------

interface HalfExtents {
  x: number;
  y: number;
  z: number;
}

/** The world-space AABB of a placement, accounting for its 90-degree rotation. */
function placementBox(p: Placement, half: HalfExtents): THREE.Box3 {
  const rotated = Math.abs(Math.sin(p.rotY)) > 0.5;
  const hx = rotated ? half.z : half.x;
  const hz = rotated ? half.x : half.z;
  return new THREE.Box3(
    new THREE.Vector3(p.x - hx, p.y, p.z - hz),
    new THREE.Vector3(p.x + hx, p.y + half.y * 2, p.z + hz)
  );
}

/**
 * Checks one placement against the roof, the walls and the spawn zones.
 *
 * The roof check is a real raycast against the level's structural mesh, not an
 * assumption about the arch: it samples a 3x3 grid over the footprint and takes
 * the LOWEST obstruction above the object's top. That catches roof trusses and
 * hanging fittings, which is exactly what the 2.91 m dip at x = 3.5..4.0 is.
 */
function validatePlacement(
  p: Placement,
  half: HalfExtents,
  ctx: CoverContext,
  ray: THREE.Raycaster,
  down: THREE.Vector3
): string[] {
  const problems: string[] = [];
  const box = placementBox(p, half);
  const top = box.max.y;

  // ---- walls: the object must sit inside the interior ----
  if (box.min.x < -ctx.halfX + 0.02 || box.max.x > ctx.halfX - 0.02) {
    problems.push(
      `WALL: "${p.name}" spans x ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)}, ` +
        `outside the interior +/-${ctx.halfX.toFixed(2)} m`
    );
  }
  if (box.min.z < -ctx.halfZ + 0.02 || box.max.z > ctx.halfZ - 0.02) {
    problems.push(
      `WALL: "${p.name}" spans z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)}, ` +
        `outside the interior +/-${ctx.halfZ.toFixed(2)} m`
    );
  }

  // ---- spawn zones: cover must never overlap one ----
  for (const zone of ctx.spawnZones) {
    const zBox = new THREE.Box3(
      new THREE.Vector3(zone.center.x - zone.half.x, 0, zone.center.z - zone.half.z),
      new THREE.Vector3(zone.center.x + zone.half.x, ctx.height, zone.center.z + zone.half.z)
    );
    if (box.intersectsBox(zBox)) {
      problems.push(
        `SPAWN: "${p.name}" overlaps the spawn zone at z ${zone.center.z.toFixed(1)}`
      );
    }
  }

  // ---- roof: raycast down over the footprint, find the lowest ceiling ----
  let lowestCeiling = Infinity;
  let ceilingAt = '';
  for (let i = 0; i <= 2; i++) {
    for (let j = 0; j <= 2; j++) {
      const sx = box.min.x + ((box.max.x - box.min.x) * i) / 2;
      const sz = box.min.z + ((box.max.z - box.min.z) * j) / 2;
      ray.set(new THREE.Vector3(sx, ctx.height + 6, sz), down);
      ray.far = ctx.height + 12;
      const hits = ray.intersectObjects(ctx.structural, false);
      for (const hit of hits) {
        if (hit.point.y > top + 0.02 && hit.point.y < lowestCeiling) {
          lowestCeiling = hit.point.y;
          ceilingAt = `(${sx.toFixed(2)}, ${sz.toFixed(2)})`;
        }
      }
    }
  }
  if (lowestCeiling !== Infinity && lowestCeiling - top < COVER.roofClearance) {
    problems.push(
      `ROOF: "${p.name}" top ${top.toFixed(2)} m has only ` +
        `${(lowestCeiling - top).toFixed(2)} m clearance (need ${COVER.roofClearance} m) ` +
        `at ${ceilingAt}`
    );
  }

  return problems;
}

/**
 * Casts a ray between the two spawn centres at eye height.
 *
 * Returns true when the line is CLEAR, which is the failure case: the brief
 * requires that it never be clear.
 */
export function spawnSightlineClear(
  physics: Physics,
  from: THREE.Vector3,
  to: THREE.Vector3
): boolean {
  const dir = new THREE.Vector3().subVectors(to, from);
  const distance = dir.length();
  if (distance < 1e-4) return true;
  dir.normalize();

  const ray = new RAPIER.Ray(
    { x: from.x, y: from.y, z: from.z },
    { x: dir.x, y: dir.y, z: dir.z }
  );
  const hit = physics.world.castRay(
    ray,
    distance,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    physics.blocksRays
  );
  return hit === null;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function addCover(physics: Physics, ctx: CoverContext): Cover {
  const root = new THREE.Group();
  root.name = 'cover';

  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const colliders: RAPIER.Collider[] = [];
  const props: CoverProp[] = [];
  const problems: string[] = [];
  const body = physics.createFixedBody();

  // Muted industrial palette. Deliberately no blues or reds: those are the
  // team colours, and cover must never be mistaken for a combatant.
  const containerMat = new THREE.MeshStandardMaterial({
    color: 0x6b6a4a,
    roughness: 0.82,
    metalness: 0.35,
  });
  const rackMat = new THREE.MeshStandardMaterial({
    color: 0x5c6066,
    roughness: 0.55,
    metalness: 0.75,
  });
  const crateMat = new THREE.MeshStandardMaterial({
    color: 0x8a6a42,
    roughness: 0.9,
    metalness: 0.0,
  });
  disposables.push(containerMat, rackMat, crateMat);

  // Rust, dirt and dust, layered procedurally in the shader. See weathering.ts.
  const { container, crate, rack } = COVER;
  applyWeathering(containerMat, {
    kind: 'container',
    half: { x: container.x / 2, y: container.y / 2, z: container.z / 2 },
    edgeWidth: 0.18,
    grimeHeight: 0.7,
  });
  applyWeathering(crateMat, {
    kind: 'crate',
    half: { x: crate.x * 0.47, y: crate.y * 0.47, z: crate.z * 0.47 },
    edgeWidth: 0.08,
    grimeHeight: 0.4,
  });
  applyWeathering(rackMat, {
    kind: 'rack',
    half: { x: rack.x / 2, y: rack.y / 2, z: rack.z / 2 },
    edgeWidth: 0.06,
    grimeHeight: 0.5,
  });

  const containerGeo = containerGeometry();
  const rackGeo = rackGeometry();
  const crateGeo = crateGeometry();
  disposables.push(containerGeo, rackGeo, crateGeo);

  const dummy = new THREE.Object3D();
  const partOffset = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);

  /**
   * Adds an instanced batch plus an exactly-matching cuboid collider each.
   *
   * With `parts`, the cuboid becomes a movement-only `blocker` (bullets and
   * sight pass through it) and each part gets its own thin `prop` collider to
   * stop rounds. The parts sit inside the cuboid, so movement is unchanged.
   */
  const batch = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    half: HalfExtents,
    placements: Placement[],
    name: string,
    surface: 'metal' | 'wood',
    parts?: PartBox[]
  ) => {
    const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    placements.forEach((p, i) => {
      // ---- validate before creating anything ----
      const found = validatePlacement(p, half, ctx, ray, down);
      if (found.length) problems.push(...found);

      dummy.position.set(p.x, p.y + half.y, p.z);
      dummy.rotation.set(0, p.rotY, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setTranslation(p.x, p.y + half.y, p.z)
        .setRotation({
          x: 0,
          y: Math.sin(p.rotY / 2),
          z: 0,
          w: Math.cos(p.rotY / 2),
        })
        .setFriction(0.85);
      const collider = physics.world.createCollider(desc, body);
      physics.tag(collider, { kind: parts ? 'blocker' : 'prop', surface });
      colliders.push(collider);
      props.push({ name: p.name, batch: name, mesh, index: i, collider, half });

      // Bullet colliders for the drawn steel. Kept out of `colliders`, which
      // feeds the navmesh: the blocker above already covers the footprint.
      for (const part of parts ?? []) {
        partOffset.set(...part.at).applyQuaternion(dummy.quaternion).add(dummy.position);
        const partDesc = RAPIER.ColliderDesc.cuboid(part.size[0] / 2, part.size[1] / 2, part.size[2] / 2)
          .setTranslation(partOffset.x, partOffset.y, partOffset.z)
          .setRotation({
            x: dummy.quaternion.x,
            y: dummy.quaternion.y,
            z: dummy.quaternion.z,
            w: dummy.quaternion.w,
          });
        physics.tag(physics.world.createCollider(partDesc, body), { kind: 'prop', surface });
      }
    });

    mesh.instanceMatrix.needsUpdate = true;
    root.add(mesh);
  };

  const containerHalf = {
    // The rails overhang the body, so the collider matches the RAILS — the
    // outermost geometry — not the body. See RAIL_OVERHANG.
    x: COVER.container.x / 2 + RAIL_OVERHANG,
    y: COVER.container.y / 2,
    z: COVER.container.z / 2 + RAIL_OVERHANG,
  };
  const rackHalf = { x: COVER.rack.x / 2, y: COVER.rack.y / 2, z: COVER.rack.z / 2 };
  const crateHalf = { x: COVER.crate.x / 2, y: COVER.crate.y / 2, z: COVER.crate.z / 2 };

  batch(containerGeo, containerMat, containerHalf, CONTAINERS_CROSS, 'cover-containers-cross', 'metal');
  batch(containerGeo, containerMat, containerHalf, CONTAINERS_LONG, 'cover-containers-long', 'metal');
  batch(rackGeo, rackMat, rackHalf, RACKS, 'cover-racks', 'metal', rackParts());
  batch(crateGeo, crateMat, crateHalf, CRATES, 'cover-crates', 'wood');

  // ---- spawn-to-spawn sightline ----
  // Eye height, because that is what a player actually sees along.
  //
  // The world is stepped once first: Rapier builds its query pipeline during
  // `step()`, so a raycast issued before the first step hits nothing and would
  // report a false "clear" — which is exactly what happened the first time this
  // check ran. One step at load time is harmless; nothing is moving yet.
  physics.world.step();
  const eye = 1.62;
  const sightline = {
    from: new THREE.Vector3(0, eye, -15.6),
    to: new THREE.Vector3(0, eye, 15.6),
  };
  const clear = spawnSightlineClear(physics, sightline.from, sightline.to);
  if (clear) {
    problems.push(
      'SIGHTLINE: the spawn centres can see each other. The brief requires this ' +
        'to be blocked — add or widen the spawn-wall containers.'
    );
  }

  const containerCount = CONTAINERS_CROSS.length + CONTAINERS_LONG.length;
  console.log(
    `[cover] ${containerCount} containers, ${RACKS.length} racking bays, ` +
      `${CRATES.length} crates | ${colliders.length} cuboid colliders | ` +
      `4 InstancedMesh draw calls`
  );
  console.log(
    `[cover] spawn sightline: ${clear ? 'CLEAR (FAIL)' : 'blocked (pass)'} | ` +
      `clearance validator: ${problems.length ? `${problems.length} problem(s)` : 'clean'}`
  );
  for (const p of problems) console.warn(`[cover] ${p}`);

  return {
    root,
    colliders,
    props,
    problems,
    sightline,
    dispose() {
      for (const d of disposables) d.dispose();
      root.removeFromParent();
    },
  };
}
