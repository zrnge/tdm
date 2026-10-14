/**
 * Reports the orientation of the viewmodel's gun mesh in model space.
 *
 * The first-person viewmodel has to be rotated so its barrel points down -Z,
 * which is the convention the rest of the game uses. Which axis the barrel lies
 * along — and which way it points — is a property of the asset, not something
 * that can be assumed, so it is measured here.
 *
 * glTF accessors carry `min`/`max`, so the bounding box of every mesh can be
 * read straight out of the JSON chunk without decoding any vertex data. Node
 * transforms are then composed down the hierarchy to put those boxes in model
 * space.
 *
 * Usage: node tools/viewmodel-orient.mjs "public/models/ak74u__free_animation..glb"
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/viewmodel-orient.mjs <model.glb>');
  process.exit(1);
}

const buf = readFileSync(path);
if (buf.readUInt32LE(0) !== 0x46546c67) {
  console.error('not a GLB (bad magic)');
  process.exit(1);
}

// ---- chunks ----
let offset = 12;
let json = null;
while (offset < buf.length) {
  const length = buf.readUInt32LE(offset);
  const type = buf.readUInt32LE(offset + 4);
  const start = offset + 8;
  if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(start, start + length).toString('utf8'));
  offset = start + length;
}
if (!json) {
  console.error('no JSON chunk');
  process.exit(1);
}

const gltf = json;

// ---------------------------------------------------------------------------
// Minimal 4x4 matrix maths (column-major, matching glTF)
// ---------------------------------------------------------------------------

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function fromTRS(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation ?? [0, 0, 0];
  const q = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** The 8 transformed corners of an axis-aligned box, as a new AABB. */
function transformBox(m, min, max) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const corner = [
      i & 1 ? max[0] : min[0],
      i & 2 ? max[1] : min[1],
      i & 4 ? max[2] : min[2],
    ];
    const p = transformPoint(m, corner);
    for (let a = 0; a < 3; a++) {
      if (p[a] < lo[a]) lo[a] = p[a];
      if (p[a] > hi[a]) hi[a] = p[a];
    }
  }
  return { min: lo, max: hi };
}

function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

// ---------------------------------------------------------------------------
// Walk the hierarchy
// ---------------------------------------------------------------------------

const meshes = [];

function visit(index, parentMatrix) {
  const node = gltf.nodes[index];
  const world = multiply(parentMatrix, fromTRS(node));

  if (node.mesh !== undefined) {
    const mesh = gltf.meshes[node.mesh];
    let box = null;
    let triangles = 0;
    for (const prim of mesh.primitives) {
      const acc = gltf.accessors[prim.attributes.POSITION];
      if (acc?.min && acc?.max) box = unionBox(box, transformBox(world, acc.min, acc.max));
      if (prim.indices !== undefined) triangles += gltf.accessors[prim.indices].count / 3;
      else triangles += acc.count / 3;
    }
    // Material names are how the gun parts are identified: the node names are
    // Object_61/62/63, the materials are Krinkov / Null.001 / Magazine.
    const matNames = mesh.primitives
      .map((p) => (p.material !== undefined ? gltf.materials[p.material]?.name : null))
      .filter(Boolean);
    meshes.push({ name: node.name ?? `node${index}`, box, triangles, matNames });
  }

  for (const child of node.children ?? []) visit(child, world);
}

const scene = gltf.scenes[gltf.scene ?? 0];
for (const root of scene.nodes) visit(root, IDENTITY);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const fmt = (n) => (n >= 0 ? ' ' : '') + n.toFixed(3).padStart(7);

console.log(`\n${path}\n${'='.repeat(72)}`);
console.log('mesh'.padEnd(20) + 'size (X, Y, Z)'.padEnd(30) + 'tris');
console.log('-'.repeat(72));
for (const m of meshes) {
  if (!m.box) continue;
  const size = [
    m.box.max[0] - m.box.min[0],
    m.box.max[1] - m.box.min[1],
    m.box.max[2] - m.box.min[2],
  ];
  console.log(
    m.name.padEnd(20) +
      size.map((s) => s.toFixed(3).padStart(8)).join(' ') +
      '   ' +
      Math.round(m.triangles).toLocaleString('en-US').padStart(8) +
      (m.matNames.length ? `   [${m.matNames.join(', ')}]` : '')
  );
}

// ---- the gun: the largest mesh whose material is a known gun material ----
const GUN_RE = /krinkov|null\.001|magazine/i;
const gunParts = meshes.filter((m) => m.box && m.matNames.some((n) => GUN_RE.test(n)));
const gunBox = gunParts.reduce((acc, m) => unionBox(acc, m.box), null);

if (!gunBox) {
  console.log('\nNo gun mesh found by material name.');
  process.exit(0);
}

const gunSize = [
  gunBox.max[0] - gunBox.min[0],
  gunBox.max[1] - gunBox.min[1],
  gunBox.max[2] - gunBox.min[2],
];
const axes = ['X', 'Y', 'Z'];
const longest = gunSize.indexOf(Math.max(...gunSize));

console.log('\nGUN (all parts with a gun material)');
console.log('-'.repeat(72));
console.log(`  min   ${gunBox.min.map(fmt).join(' ')}`);
console.log(`  max   ${gunBox.max.map(fmt).join(' ')}`);
console.log(`  size  ${gunSize.map(fmt).join(' ')}`);
console.log(`  barrel axis: ${axes[longest]}  (length ${gunSize[longest].toFixed(3)})`);

// Which end is the muzzle? The muzzle is the end furthest from the arms'
// centre of mass, so compare both ends against the arms' centroid.
const armsBox = meshes
  .filter((m) => m.box && !m.matNames.some((n) => GUN_RE.test(n)))
  .reduce((acc, m) => unionBox(acc, m.box), null);

if (armsBox) {
  const armsCentre = [
    (armsBox.min[0] + armsBox.max[0]) / 2,
    (armsBox.min[1] + armsBox.max[1]) / 2,
    (armsBox.min[2] + armsBox.max[2]) / 2,
  ];
  const distToMin = Math.abs(gunBox.min[longest] - armsCentre[longest]);
  const distToMax = Math.abs(gunBox.max[longest] - armsCentre[longest]);
  const muzzleEnd = distToMin > distToMax ? 'min' : 'max';
  const sign = muzzleEnd === 'min' ? '-' : '+';
  console.log(`  muzzle at ${axes[longest]}${sign} (${gunBox[muzzleEnd][longest].toFixed(3)}), ` +
    `arms centre ${axes[longest]}=${armsCentre[longest].toFixed(3)}`);

  // ---- the rotation that brings that axis onto -Z ----
  console.log('\n  To point the barrel down -Z, rotate about:');
  if (axes[longest] === 'Y') {
    console.log(
      muzzleEnd === 'max'
        ? '    X by -90 degrees   (maps +Y to -Z)'
        : '    X by +90 degrees   (maps -Y to -Z)'
    );
  } else if (axes[longest] === 'X') {
    console.log(
      muzzleEnd === 'max'
        ? '    Y by +90 degrees   (maps +X to -Z)'
        : '    Y by -90 degrees   (maps -X to -Z)'
    );
  } else {
    console.log(
      muzzleEnd === 'max'
        ? '    Y by 180 degrees   (maps +Z to -Z)'
        : '    none — the barrel already points down -Z'
    );
  }
}

console.log('');
