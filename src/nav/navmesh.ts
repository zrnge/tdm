/**
 * Navigation mesh: built from the warehouse floor, the structural shell, and
 * every cover collider.
 *
 * ## What goes in, and why
 *
 * recast-navigation builds a navmesh from raw triangles. Three inputs, each
 * solving a problem the others cannot:
 *
 *  1. **A ground plane.** The model's floor is a 2-triangle quad with material
 *     `WetConcrete`, which `level.ts` deliberately keeps out of the structural
 *     mesh. Without a floor there is nothing to walk on, so one quad is added
 *     covering the hall footprint, extending slightly past the wall line.
 *
 *  2. **The structural shell** (`level.structural`, the `Metal` mesh: walls,
 *     arched roof, trusses). This is what stops the navmesh leaking out of the
 *     hall, and — less obviously — what stops bots pathing onto the TOPS of the
 *     containers. Recast marks a surface walkable when it has `walkableHeight`
 *     of clearance above it. With no ceiling in the input, a container top at
 *     2.59 m has infinite headroom and becomes a perfectly valid walkable island,
 *     which `findRandomPointAroundCircle` will happily hand back as a patrol
 *     destination. The roof supplies the missing ceiling.
 *
 *  3. **Every cover collider, as a box.** Cover is drawn as `InstancedMesh`,
 *     which has no per-instance geometry to hand to Recast. Its colliders are
 *     exact cuboids and a cuboid is 12 triangles, so the navmesh is built from
 *     the same volumes that stop the player. Navmesh and collision cannot drift.
 *
 * ## Configuration
 *
 * The agent is a 0.34 m radius, 1.8 m tall humanoid that must fit through the
 * 1.36 m chokepoint on the centre line and under the 2.91 m roof dip. `cs` 0.15
 * gives 15 cm voxels, fine enough to resolve that chokepoint. `walkableClimb`
 * 0.45 m lets a bot step onto a pallet lip but not onto a 1.2 m crate.
 *
 * ## Erosion
 *
 * Recast erodes the walkable area by `walkableRadius` from every obstacle,
 * including the outer boundary of the input. The navmesh therefore stops about
 * one agent-radius short of any wall, which is correct — a bot's centre must
 * never be closer to a wall than its own radius. The ground plane is extended
 * past the wall line so that the WALL is the boundary the erosion works from,
 * not the plane's own edge.
 */
import * as THREE from 'three';
import { NavMesh, NavMeshQuery, getNavMeshPositionsAndIndices, init } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import { BOT } from '../config';
import type { Level } from '../level/level';

export interface NavMeshSystem {
  /** The generated mesh, or null when generation failed. */
  readonly navMesh: NavMesh | null;
  /** Query interface for paths and random points. Null when generation failed. */
  readonly query: NavMeshQuery | null;
  /** Walkable surface as a `LineSegments`-ready geometry, for the F3 overlay. */
  readonly debugLines: THREE.BufferGeometry | null;
  /** Statistics for the console report. */
  readonly stats: {
    polygons: number;
    vertices: number;
    generationMs: number;
    inputTriangles: number;
    error: string | null;
  };
  /** Nearest walkable point to `p`, or null when nothing is within `maxDist`. */
  nearestPoint(p: THREE.Vector3, maxDist?: number): THREE.Vector3 | null;
  /**
   * A path from `from` to `to` as world-space waypoints, or an empty array when
   * no path exists. The first point is the first corner to walk toward.
   */
  path(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[];
  /** A random walkable point within `radius` of `around`, or null. */
  randomPointAround(around: THREE.Vector3, radius: number): THREE.Vector3 | null;
  /** True when `p` is on or very near the navmesh. */
  isWalkable(p: THREE.Vector3, tolerance?: number): boolean;
  dispose(): void;
}

/** Recast cell size, metres. 0.15 resolves the 1.36 m centre-line chokepoint. */
const CELL_SIZE = 0.15;
/** Recast cell height, metres. */
const CELL_HEIGHT = 0.15;
/**
 * How far the ground plane extends past the interior wall line, metres.
 *
 * It must extend past the wall so the wall becomes the navmesh boundary; if the
 * plane ended exactly at the wall, erosion would work from the plane's own edge
 * and the result would be the same, but a plane that ends *inside* the wall
 * would leave a strip of floor unreachable. 0.5 m is comfortably past the wall
 * and still inside the warehouse shell.
 */
const GROUND_OVERHANG = 0.5;

export async function buildNavMesh(level: Level): Promise<NavMeshSystem> {
  const started = performance.now();

  await init();

  const positions: number[] = [];
  const indices: number[] = [];

  // ---- 1. ground plane ----
  const halfX = level.size.x / 2 + GROUND_OVERHANG;
  const halfZ = level.size.z / 2 + GROUND_OVERHANG;
  // A hair above the floor mesh, so it is unambiguously the walkable surface
  // rather than z-fighting with the floor's own top face.
  const groundY = 0.02;

  const base = positions.length / 3;
  positions.push(
    -halfX, groundY, -halfZ,
     halfX, groundY, -halfZ,
     halfX, groundY,  halfZ,
    -halfX, groundY,  halfZ
  );
  // Wound so the normal points +Y, which is what `markWalkableTriangles` tests.
  indices.push(base, base + 2, base + 1, base, base + 3, base + 2);

  // ---- 2. the structural shell: walls, roof, trusses ----
  let structuralTriangles = 0;
  const v = new THREE.Vector3();
  for (const mesh of level.structural) {
    mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos) continue;

    const meshBase = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }

    const geoIndex = geo.getIndex();
    if (geoIndex) {
      for (let i = 0; i < geoIndex.count; i++) indices.push(meshBase + geoIndex.getX(i));
      structuralTriangles += geoIndex.count / 3;
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(meshBase + i);
      structuralTriangles += pos.count / 3;
    }
  }

  // ---- 3. every cover collider, as a box ----
  let coverTriangles = 0;
  for (const collider of level.cover.colliders) {
    const half = collider.halfExtents();
    if (!half) continue;
    const t = collider.translation();
    const r = collider.rotation();
    appendBox(
      positions,
      indices,
      new THREE.Vector3(t.x, t.y, t.z),
      half,
      new THREE.Quaternion(r.x, r.y, r.z, r.w)
    );
    coverTriangles += 12;
  }

  const inputTriangles = 2 + structuralTriangles + coverTriangles;

  // ---- 4. generate ----
  const result = generateSoloNavMesh(positions, indices, {
    cs: CELL_SIZE,
    ch: CELL_HEIGHT,
    // The agent. Radius is what drives the distance kept from every obstacle.
    walkableRadius: Math.ceil(BOT.radius / CELL_SIZE),
    walkableHeight: Math.ceil(BOT.height / CELL_HEIGHT),
    // A bot may step onto a 0.2 m pallet lip, not onto a 1.2 m crate.
    walkableClimb: Math.ceil(0.45 / CELL_HEIGHT),
    walkableSlopeAngle: 45,
  });

  const generationMs = performance.now() - started;

  if (!result.success) {
    console.error(
      `[navmesh] generation FAILED after ${generationMs.toFixed(0)} ms: ${result.error}`
    );
    return failedSystem(generationMs, inputTriangles, result.error);
  }

  const navMesh = result.navMesh;
  const query = new NavMeshQuery(navMesh);

  // ---- 5. extract the walkable surface for the debug draw ----
  const [navPositions, navIndices] = getNavMeshPositionsAndIndices(navMesh);
  const debugLines = buildWireframe(navPositions, navIndices);

  const stats = {
    polygons: Math.round(navIndices.length / 3),
    vertices: Math.round(navPositions.length / 3),
    generationMs,
    inputTriangles,
    error: null as string | null,
  };

  console.log(
    `[navmesh] ${stats.polygons.toLocaleString('en-US')} polygons, ` +
      `${stats.vertices.toLocaleString('en-US')} vertices | built in ` +
      `${generationMs.toFixed(0)} ms from ${inputTriangles.toLocaleString('en-US')} input ` +
      `triangles (1 ground quad + ${structuralTriangles.toLocaleString('en-US')} structural + ` +
      `${coverTriangles} cover) | cell ${CELL_SIZE} m, agent radius ${BOT.radius} m`
  );

  // ---- 6. sanity probes ----
  // A navmesh that failed to cover the hall is worse than none: bots would
  // silently refuse to move and the cause would be invisible on screen. Probe
  // the places every route must reach.
  const probes: { label: string; at: THREE.Vector3 }[] = [
    ...level.spawnZones.map((z) => ({
      label: `${z.team} spawn`,
      at: new THREE.Vector3(z.center.x, 0, z.center.z),
    })),
    { label: 'centre line', at: new THREE.Vector3(0, 0, 0) },
    { label: 'west flank', at: new THREE.Vector3(-6.3, 0, 0) },
    { label: 'east flank', at: new THREE.Vector3(6.3, 0, 0) },
  ];
  let unreachable = 0;
  for (const probe of probes) {
    if (!nearestWalkable(query, probe.at, 3)) {
      unreachable++;
      console.warn(
        `[navmesh] WARNING: no walkable surface within 3 m of the ${probe.label} ` +
          `(${probe.at.x.toFixed(1)}, ${probe.at.z.toFixed(1)}) — bots cannot reach it.`
      );
    }
  }
  if (!unreachable) {
    console.log(
      `[navmesh] all ${probes.length} reachability probes passed ` +
        `(both spawns, centre line, both flank lanes)`
    );
  }

  return {
    navMesh,
    query,
    debugLines,
    stats,

    nearestPoint(p, maxDist = 4) {
      return nearestWalkable(query, p, maxDist);
    },

    path(from, to) {
      return computePath(query, from, to);
    },

    randomPointAround(around, radius) {
      const res = query.findRandomPointAroundCircle(around, radius);
      if (!res.success) return null;
      return new THREE.Vector3(res.randomPoint.x, res.randomPoint.y, res.randomPoint.z);
    },

    isWalkable(p, tolerance = 0.6) {
      const res = query.findNearestPoly(p, {
        halfExtents: { x: tolerance, y: 1.5, z: tolerance },
      });
      if (!res.success) return false;
      const dx = res.nearestPoint.x - p.x;
      const dz = res.nearestPoint.z - p.z;
      return Math.hypot(dx, dz) <= tolerance;
    },

    dispose() {
      debugLines?.dispose();
      query.destroy();
      navMesh.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Appends the 12 triangles of an oriented box to the position/index arrays.
 *
 * Winding is outward on every face, which matters: Recast's `markWalkableTriangles`
 * decides walkability from the triangle normal against the up vector, so an
 * inside-out box would present its interior as walkable floor.
 */
function appendBox(
  positions: number[],
  indices: number[],
  center: THREE.Vector3,
  half: { x: number; y: number; z: number },
  rotation: THREE.Quaternion
) {
  const base = positions.length / 3;
  const corners: [number, number, number][] = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  const v = new THREE.Vector3();
  for (const [sx, sy, sz] of corners) {
    v.set(sx * half.x, sy * half.y, sz * half.z).applyQuaternion(rotation).add(center);
    positions.push(v.x, v.y, v.z);
  }
  // Each quad as [a, b, c, d], split into (a,b,c) and (a,c,d).
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1], // -Z
    [4, 5, 6, 7], // +Z
    [0, 4, 7, 3], // -X
    [1, 2, 6, 5], // +X
    [3, 7, 6, 2], // +Y
    [0, 1, 5, 4], // -Y
  ];
  for (const [a, b, c, d] of quads) {
    indices.push(base + a, base + b, base + c);
    indices.push(base + a, base + c, base + d);
  }
}

/** Builds a `LineSegments`-ready geometry from a triangle soup. */
function buildWireframe(positions: number[], indices: number[]): THREE.BufferGeometry | null {
  if (!indices.length) return null;
  const points: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    // Three edges per triangle. Duplicates are harmless for a wireframe and
    // avoid a hashing pass over a few thousand triangles.
    points.push(
      positions[a], positions[a + 1], positions[a + 2],
      positions[b], positions[b + 1], positions[b + 2],
      positions[b], positions[b + 1], positions[b + 2],
      positions[c], positions[c + 1], positions[c + 2],
      positions[c], positions[c + 1], positions[c + 2],
      positions[a], positions[a + 1], positions[a + 2]
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return geo;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

function nearestWalkable(
  query: NavMeshQuery,
  p: THREE.Vector3,
  maxDist: number
): THREE.Vector3 | null {
  const res = query.findNearestPoly(p, {
    halfExtents: { x: maxDist, y: 2.5, z: maxDist },
  });
  if (!res.success) return null;
  return new THREE.Vector3(res.nearestPoint.x, res.nearestPoint.y, res.nearestPoint.z);
}

/**
 * Computes a path and returns it as world-space waypoints.
 *
 * `computePath` does the polygon-corridor walk and the string-pulling in one
 * call, which is what a bot needs: a list of corners to walk between. The first
 * point is dropped when it is within a few centimetres of the bot's own
 * position, because steering toward the point you are already standing on gives
 * a zero-length direction and a bot that spins on the spot.
 */
function computePath(
  query: NavMeshQuery,
  from: THREE.Vector3,
  to: THREE.Vector3
): THREE.Vector3[] {
  const result = query.computePath(from, to);
  if (!result.success || !result.path.length) return [];

  const out: THREE.Vector3[] = [];
  for (const p of result.path) {
    const point = new THREE.Vector3(p.x, p.y, p.z);
    if (out.length === 0 && point.distanceTo(from) < 0.25) continue;
    out.push(point);
  }
  // End on the requested goal when the navmesh reached it, so a bot does not
  // stop a polygon short of where it was told to go.
  if (out.length) {
    const last = out[out.length - 1];
    if (last.distanceTo(to) < 1.5) last.copy(to);
  }
  return out;
}

function failedSystem(
  generationMs: number,
  inputTriangles: number,
  error: string
): NavMeshSystem {
  return {
    navMesh: null,
    query: null,
    debugLines: null,
    stats: { polygons: 0, vertices: 0, generationMs, inputTriangles, error },
    nearestPoint: () => null,
    path: () => [],
    randomPointAround: () => null,
    isWalkable: () => false,
    dispose() {
      /* nothing was created */
    },
  };
}
