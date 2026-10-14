/**
 * Level loading and collider generation.
 *
 * The supplied warehouse is a single 10.6k-triangle `Metal` mesh (structure),
 * an `Emissive` mesh (ceiling lamps) and a `WetConcrete` mesh that is a single
 * flat 2-triangle quad. So:
 *
 *   - `Metal`      -> Rapier trimesh collider (walls, roof, trusses, fittings)
 *   - `Emissive`   -> SKIPPED, lamps must not be solid
 *   - `WetConcrete`-> thin cuboid slab (a 2-triangle trimesh has no thickness
 *                     and a capsule would tunnel straight through it)
 *
 * The model is also re-centred on the world origin so gameplay code can treat
 * (0,0,0) as the middle of the hall.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LEVEL, SPAWN, TEAM } from '../config';
import { RAPIER, type Physics } from '../core/physics';
import { addCover, spawnSightlineClear, type Cover } from './cover';

export interface SpawnZone {
  team: keyof typeof TEAM;
  /** Centre of the zone in world space. */
  center: THREE.Vector3;
  /** Zone half-extents, for drawing and for scattering spawn points. */
  half: THREE.Vector3;
}

export interface Level {
  /** Root object to add to the scene. */
  root: THREE.Group;
  /** Interior size in metres (W x H x D). */
  size: THREE.Vector3;
  /** World-space centre of the interior. */
  center: THREE.Vector3;
  /** Structural mesh, kept for navmesh generation in Phase 3. */
  structural: THREE.Mesh[];
  /** Meshes excluded from collision, kept for reference. */
  decorative: THREE.Mesh[];
  /** Containers, crate stacks and pallet racking added as cover. */
  cover: Cover;
  spawnZones: SpawnZone[];
  /** Picks a random floor point inside a team's spawn zone. */
  randomSpawn(team: keyof typeof TEAM): THREE.Vector3;
  /**
   * True when the two spawn centres can see each other. The brief requires this
   * to be false; the F3 overlay draws the line red when it becomes true.
   */
  spawnSightlineClear(): boolean;
  dispose(): void;
}

/** Materials that must never produce a collider. */
const NON_COLLIDING = new Set<string>(LEVEL.nonCollidingMaterials);

export async function loadLevel(physics: Physics): Promise<Level> {
  const gltf = await new GLTFLoader().loadAsync(LEVEL.url);

  const root = new THREE.Group();
  root.name = 'level';
  root.add(gltf.scene);

  // ---- measure, then re-centre so (0,0,0) is the middle of the hall floor ----
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  gltf.scene.position.set(-center.x, -box.min.y, -center.z);
  root.updateMatrixWorld(true);

  // ---- sort meshes into structural / decorative ----
  const structural: THREE.Mesh[] = [];
  const decorative: THREE.Mesh[] = [];
  const floorMeshes: THREE.Mesh[] = [];

  gltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    // Sketchfab meshes are posed by a parent transform chain; bake it so the
    // collider geometry matches what is on screen.
    mesh.updateWorldMatrix(true, false);

    const matName = materialName(mesh);
    if (NON_COLLIDING.has(matName)) {
      decorative.push(mesh);
      return;
    }
    if (matName === LEVEL.floorMaterial) {
      floorMeshes.push(mesh);
      return;
    }
    structural.push(mesh);
  });

  // ---- structural: one trimesh collider for the whole level shell ----
  const body = physics.createFixedBody();
  let trimeshTris = 0;

  for (const mesh of structural) {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos) continue;

    const vertices = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld);
      vertices[i * 3] = v.x;
      vertices[i * 3 + 1] = v.y;
      vertices[i * 3 + 2] = v.z;
    }

    let indices: Uint32Array;
    const geoIndex = geo.getIndex();
    if (geoIndex) {
      indices = new Uint32Array(geoIndex.array);
    } else {
      indices = new Uint32Array(pos.count);
      for (let i = 0; i < pos.count; i++) indices[i] = i;
    }

    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(0.8);
    const collider = physics.world.createCollider(desc, body);
    physics.tag(collider, { kind: 'world' });
    trimeshTris += indices.length / 3;
  }

  // ---- floor: a real slab, because the model's floor is a 2-triangle plane ----
  const floorBox = new THREE.Box3();
  for (const mesh of floorMeshes) floorBox.expandByObject(mesh);
  if (floorMeshes.length && !floorBox.isEmpty()) {
    const fSize = floorBox.getSize(new THREE.Vector3());
    const fCenter = floorBox.getCenter(new THREE.Vector3());
    const desc = RAPIER.ColliderDesc.cuboid(
      fSize.x / 2,
      LEVEL.floorThickness / 2,
      fSize.z / 2
    )
      .setTranslation(fCenter.x, fCenter.y - LEVEL.floorThickness / 2, fCenter.z)
      .setFriction(0.9);
    physics.tag(physics.world.createCollider(desc, body), { kind: 'world' });
  }

  // Fallback: if the model had no floor mesh at all, add a slab covering the
  // whole footprint so the player can never fall out of the world.
  if (floorMeshes.length === 0) {
    const desc = RAPIER.ColliderDesc.cuboid(size.x / 2, LEVEL.floorThickness / 2, size.z / 2)
      .setTranslation(0, -LEVEL.floorThickness / 2, 0)
      .setFriction(0.9);
    physics.tag(physics.world.createCollider(desc, body), { kind: 'world' });
  }

  // ---- floor surface: matte concrete, not a wet mirror ----
  // The supplied material is named "WetConcrete" and ships with roughness and
  // metalness maps that make it behave like a wet mirror under an HDRI. The
  // brief asks for matte concrete, so the maps are dropped and the scalar
  // values are forced. Kept as a named function so it is obvious this is a
  // deliberate override of the source asset rather than a stray tweak.
  for (const mesh of floorMeshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      const std = mat as THREE.MeshStandardMaterial;
      if (LEVEL.floorDropWetMaps) {
        std.roughnessMap = null;
        std.metalnessMap = null;
        std.normalMap = null;
      }
      std.roughness = LEVEL.floorRoughness;
      std.metalness = LEVEL.floorMetalness;
      std.envMapIntensity = LEVEL.floorEnvMapIntensity;
      std.needsUpdate = true;
    }
    mesh.receiveShadow = true;
  }

  // ---- spawn zones at opposite ends of the hall ----
  // Inset far enough from the end walls that the third-person camera (3.7 m
  // behind the player) is not immediately pushed into the wall on spawn, and
  // shallow enough that the zone ends before the spawn-wall cover begins at
  // z = -/+10.8. A player must never spawn inside a container.
  const halfX = (size.x / 2 - 1.2) * SPAWN.widthFraction;
  const halfZ = SPAWN.halfDepth;
  const spawnZones: SpawnZone[] = [
    {
      team: 'blue',
      center: new THREE.Vector3(TEAM.blue.spawnCenter.x, 0, TEAM.blue.spawnCenter.z),
      half: new THREE.Vector3(halfX, 0, halfZ),
    },
    {
      team: 'red',
      center: new THREE.Vector3(TEAM.red.spawnCenter.x, 0, TEAM.red.spawnCenter.z),
      half: new THREE.Vector3(halfX, 0, halfZ),
    },
  ];

  // ---- cover: containers, crate stacks, pallet racking ----
  // Built AFTER the spawn zones, because the clearance validator checks every
  // prop against them (and against the real roof, by raycast).
  const cover = addCover(physics, {
    structural,
    spawnZones,
    halfX: size.x / 2,
    halfZ: size.z / 2,
    height: size.y,
  });
  root.add(cover.root);

  // Visual markers so the zones are verifiable in-game.
  for (const zone of spawnZones) {
    const color = TEAM[zone.team].accent;
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(
        Math.min(zone.half.x, 3.2) - 0.12,
        Math.min(zone.half.x, 3.2),
        48
      ),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
    );
    marker.rotation.x = -Math.PI / 2;
    marker.position.set(zone.center.x, 0.02, zone.center.z);
    marker.name = `spawn-zone-${zone.team}`;
    root.add(marker);
  }

  console.log(
    `[level] interior ${size.x.toFixed(2)} x ${size.z.toFixed(2)} x ${size.y.toFixed(2)} m | ` +
      `trimesh colliders: ${structural.length} mesh(es), ${Math.round(trimeshTris).toLocaleString('en-US')} tris | ` +
      `floor slabs: ${floorMeshes.length || 'fallback'} | ` +
      `excluded (no collision): ${decorative.map((m) => materialName(m)).join(', ') || 'none'}`
  );

  return {
    root,
    size,
    center: new THREE.Vector3(0, size.y / 2, 0),
    structural,
    decorative,
    cover,
    spawnZones,
    randomSpawn(team) {
      const zone = spawnZones.find((z) => z.team === team)!;
      return new THREE.Vector3(
        zone.center.x + (Math.random() * 2 - 1) * zone.half.x * 0.8,
        0.05,
        zone.center.z + (Math.random() * 2 - 1) * zone.half.z * 0.8
      );
    },
    spawnSightlineClear() {
      return spawnSightlineClear(physics, cover.sightline.from, cover.sightline.to);
    },
    dispose() {
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m?.dispose();
      });
    },
  };
}

function materialName(mesh: THREE.Mesh): string {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return mat?.name ?? '';
}
