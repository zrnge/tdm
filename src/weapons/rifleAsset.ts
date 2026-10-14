/**
 * The third-person rifle carried by every character.
 *
 * ## Why the supplied model is not used here
 *
 * `ak74u__free_animation..glb` contains a 49,666-triangle rifle. Attaching that
 * to 8 characters would put roughly 400,000 triangles of gun in the scene —
 * more than the entire warehouse level, and 8x the per-character budget. It is
 * also skinned across joints hanging off a free-floating `Bone_043`, so the
 * weapon only reaches the hands at particular frames of particular clips; a
 * rigid attachment has to be recovered by baking a frame, which is fragile and
 * was abandoned for exactly that reason.
 *
 * That asset is kept for what it is genuinely good at: the first-person
 * aim-down-sights viewmodel (`viewmodel.ts`), where exactly one instance exists
 * and the triangle cost is paid once.
 *
 * ## What is used instead
 *
 * A procedural placeholder rifle assembled from boxes — about 130 triangles,
 * correct AK-74U proportions (0.73 m long), grip at the origin and barrel
 * pointing down -Z, so it drops onto `RightHand` with no per-model special
 * casing.
 *
 * Drop a real low-poly rifle at `RIFLE.modelUrl` and it is used automatically
 * instead; this module normalises whatever it finds (longest axis becomes the
 * barrel, scaled to `RIFLE.length`, centred on the origin). See
 * `docs/MIXAMO-SETUP.md` for which model to download.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RIFLE } from '../config';

export interface RifleAsset {
  /**
   * Geometry in the hand bone's local space: grip at the origin, barrel down
   * -Z. Shared by every character — do not dispose it per character.
   */
  geometry: THREE.BufferGeometry;
  /** Muzzle position in hand space, for tracer origin and line-of-fire checks. */
  muzzleOffset: THREE.Vector3;
  /** Distance from the grip to the muzzle, metres. */
  length: number;
  /** Where this rifle came from. */
  source: 'placeholder' | 'model';
  /** Diagnostics, logged once at load. */
  report: RifleReport;
}

export interface RifleReport {
  source: string;
  triangles: number;
  vertices: number;
  /** Size in hand space, metres (X, Y, Z). */
  size: [number, number, number];
  /** Direction the barrel points in hand space. */
  muzzleDirection: [number, number, number];
  /** True when the rifle is a sensible length for an AK-74U. */
  lengthLooksValid: boolean;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Returns the rifle every character carries.
 *
 * Prefers a real model at `RIFLE.modelUrl`; falls back to the procedural
 * placeholder when that file is absent, which is not an error.
 */
export async function loadRifle(): Promise<RifleAsset> {
  const fromModel = await tryLoadRifleModel();
  return fromModel ?? buildPlaceholderRifle();
}

async function tryLoadRifleModel(): Promise<RifleAsset | null> {
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(RIFLE.modelUrl);
  } catch {
    return null;
  }

  const meshes: THREE.Mesh[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) meshes.push(m);
  });
  if (!meshes.length) return null;

  // Bake each mesh's world transform into its geometry so the parts can be
  // merged into one buffer.
  const baked: THREE.BufferGeometry[] = [];
  for (const mesh of meshes) {
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld);
    baked.push(stripToPositionNormalUv(geo));
  }
  const merged = baked.length === 1 ? baked[0] : mergeSimple(baked);
  for (const g of baked) if (g !== merged) g.dispose();

  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const size = box.getSize(new THREE.Vector3());

  // ---- orient: the longest axis is the barrel, and it must point down -Z ----
  const longest = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
  if (longest === 'x') merged.rotateY(Math.PI / 2);
  else if (longest === 'y') merged.rotateX(Math.PI / 2);

  // ---- scale to the real weapon length ----
  merged.computeBoundingBox();
  const box2 = merged.boundingBox!;
  const size2 = box2.getSize(new THREE.Vector3());
  const rawLength = size2.z;
  const scale = rawLength > 1e-4 ? RIFLE.length / rawLength : 1;
  merged.scale(scale, scale, scale);

  // ---- centre on the origin ----
  // A generic model carries no information about where its grip is, so the
  // bounding-box centre is used. That is a predictable starting point, and the
  // F4 grip tool moves it from there.
  merged.computeBoundingBox();
  const box3 = merged.boundingBox!;
  const centre = box3.getCenter(new THREE.Vector3());
  merged.translate(-centre.x, -centre.y, -centre.z);

  merged.computeVertexNormals();
  merged.computeBoundingBox();
  const finalBox = merged.boundingBox!;

  const { muzzle, muzzleDistance } = findMuzzle(merged);

  const report: RifleReport = {
    source: RIFLE.modelUrl,
    triangles: countTriangles(merged),
    vertices: merged.getAttribute('position').count,
    size: [finalBox.max.x - finalBox.min.x, finalBox.max.y - finalBox.min.y, finalBox.max.z - finalBox.min.z],
    muzzleDirection: muzzle.clone().normalize().toArray() as [number, number, number],
    lengthLooksValid: true,
  };

  logReport(report, `loaded ${RIFLE.modelUrl}`);
  console.log(
    `[rifle] NOTE: a generic model has no grip information, so the origin sits at ` +
      `the bounding-box centre. Press F4 in game to slide it onto the pistol grip.`
  );

  return {
    geometry: merged,
    muzzleOffset: muzzle,
    length: muzzleDistance,
    source: 'model',
    report,
  };
}

// ---------------------------------------------------------------------------
// Procedural placeholder
// ---------------------------------------------------------------------------

/**
 * An AK-74U in boxes.
 *
 * Authored directly in hand space: the pistol grip is at the origin and the
 * barrel runs down -Z, matching the character's forward axis. Overall length is
 * 0.73 m, the real weapon's.
 */
function buildPlaceholderRifle(): RifleAsset {
  const parts: THREE.BufferGeometry[] = [];

  /** Adds a box, optionally pitched about X, at a position in hand space. */
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, pitch = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (pitch) g.rotateX(pitch);
    g.translate(x, y, z);
    parts.push(g);
  };

  // ---- receiver and dust cover ----
  box(0.055, 0.085, 0.30, 0, 0.005, -0.09);
  box(0.05, 0.032, 0.20, 0, 0.058, -0.09);

  // ---- pistol grip: the origin of the whole asset ----
  box(0.038, 0.115, 0.055, 0, -0.075, 0.02, -0.22);

  // ---- trigger guard ----
  box(0.03, 0.012, 0.06, 0, -0.048, -0.035);

  // ---- magazine, raked forward like a real AK ----
  box(0.032, 0.16, 0.075, 0, -0.105, -0.105, 0.18);

  // ---- handguard ----
  box(0.052, 0.055, 0.16, 0, 0.0, -0.26);

  // ---- barrel ----
  box(0.018, 0.018, 0.20, 0, 0.012, -0.38);

  // ---- gas block / front sight post ----
  box(0.03, 0.05, 0.03, 0, 0.04, -0.35);

  // ---- muzzle brake ----
  box(0.026, 0.026, 0.04, 0, 0.012, -0.47);

  // ---- side-folding stock, folded along the receiver ----
  box(0.04, 0.055, 0.17, 0, 0.0, 0.155);

  const merged = mergeSimple(parts);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  merged.computeBoundingBox();

  const finalBox = merged.boundingBox!;
  const { muzzle, muzzleDistance } = findMuzzle(merged);

  const report: RifleReport = {
    source: 'procedural placeholder',
    triangles: countTriangles(merged),
    vertices: merged.getAttribute('position').count,
    size: [finalBox.max.x - finalBox.min.x, finalBox.max.y - finalBox.min.y, finalBox.max.z - finalBox.min.z],
    muzzleDirection: muzzle.clone().normalize().toArray() as [number, number, number],
    lengthLooksValid: muzzleDistance > 0.3 && muzzleDistance < 1.2,
  };

  logReport(report, 'built procedural placeholder');
  console.log(
    `[rifle] placeholder is ${report.triangles} triangles, so 8 characters cost ` +
      `${(report.triangles * 8).toLocaleString('en-US')} triangles of gun in total. ` +
      `Drop a real model at ${RIFLE.modelUrl} to replace it — see docs/MIXAMO-SETUP.md.`
  );

  return {
    geometry: merged,
    muzzleOffset: muzzle,
    length: muzzleDistance,
    source: 'placeholder',
    report,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The muzzle: the vertex furthest along -Z, which is where the barrel points.
 *
 * Found by search rather than assumed, so a model whose barrel does not sit on
 * the centre line still reports its muzzle correctly.
 */
function findMuzzle(geometry: THREE.BufferGeometry): { muzzle: THREE.Vector3; muzzleDistance: number } {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const muzzle = new THREE.Vector3(0, 0, -RIFLE.length);
  let best = Infinity;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (v.z < best) {
      best = v.z;
      muzzle.copy(v);
    }
  }
  return { muzzle, muzzleDistance: muzzle.length() };
}

function countTriangles(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return Math.round(index.count / 3);
  return Math.round(geometry.getAttribute('position').count / 3);
}

/** Keeps only position/normal/uv, so parts with differing attributes can merge. */
function stripToPositionNormalUv(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  out.setAttribute('position', pos.clone());
  if (nor) out.setAttribute('normal', nor.clone());
  if (uv) out.setAttribute('uv', uv.clone());
  const index = geometry.getIndex();
  if (index) out.setIndex(index.clone());
  return out;
}

/** Minimal merge for position/normal/uv geometries. */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geos.length === 1) return geos[0];

  let vertexCount = 0;
  let indexCount = 0;
  const hasUv = geos.every((g) => g.getAttribute('uv'));
  for (const g of geos) {
    vertexCount += g.getAttribute('position').count;
    const idx = g.getIndex();
    if (idx) indexCount += idx.count;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = hasUv ? new Float32Array(vertexCount * 2) : null;
  const indices = new Uint32Array(indexCount);

  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const u = g.getAttribute('uv') as THREE.BufferAttribute | undefined;

    positions.set(p.array as Float32Array, vOff * 3);
    if (n) normals.set(n.array as Float32Array, vOff * 3);
    if (uvs && u) uvs.set(u.array as Float32Array, vOff * 2);

    const idx = g.getIndex();
    if (idx) {
      const a = idx.array;
      for (let i = 0; i < a.length; i++) indices[iOff + i] = a[i] + vOff;
      iOff += a.length;
    }
    vOff += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (uvs) out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}

function logReport(report: RifleReport, what: string): void {
  const [sx, sy, sz] = report.size;
  console.log(
    `[rifle] ${what} | ${report.triangles.toLocaleString('en-US')} tris, ` +
      `${report.vertices.toLocaleString('en-US')} verts | ` +
      `size ${sx.toFixed(3)} x ${sy.toFixed(3)} x ${sz.toFixed(3)} m | ` +
      `muzzle [${report.muzzleDirection.map((n) => n.toFixed(2)).join(', ')}]` +
      `${report.lengthLooksValid ? '' : ' | WARNING: length outside the expected AK-74U range'}`
  );
}

/**
 * The rifle's material, shared by every character so all 8 copies look identical.
 */
export function rifleMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x2b2b2e,
    roughness: 0.55,
    metalness: 0.75,
  });
}
