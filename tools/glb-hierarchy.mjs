/**
 * Dumps a GLB's node hierarchy, local transforms and animation channels.
 *
 * Why this exists: the first-person viewmodel has to be rotated so its barrel
 * points down -Z. Before applying a rotation of our own we need to know what
 * rotation the asset ALREADY carries. Sketchfab exports almost always wrap the
 * model in a `Sketchfab_model` node rotated -90 degrees about X, converting the
 * authoring tool's Z-up space to glTF's Y-up space. Applying our own -90 on top
 * of that doubles the correction and tips the whole rig onto its back — which is
 * precisely the bug this tool was written to diagnose.
 *
 * Usage: node tools/glb-hierarchy.mjs "public/models/ak74u__free_animation..glb"
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/glb-hierarchy.mjs <model.glb>');
  process.exit(1);
}

const buf = readFileSync(path);
if (buf.readUInt32LE(0) !== 0x46546c67) {
  console.error('not a GLB (bad magic)');
  process.exit(1);
}

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

/** Euler XYZ in degrees from a column-major 4x4, matching THREE.Euler. */
function matrixToEulerDeg(m) {
  const m11 = m[0], m12 = m[4], m13 = m[8];
  const m22 = m[5], m23 = m[9];
  const m32 = m[6], m33 = m[10];
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  let ex, ez;
  if (Math.abs(m13) < 0.9999999) {
    ex = Math.atan2(-m23, m33);
    ez = Math.atan2(-m12, m11);
  } else {
    ex = Math.atan2(m32, m22);
    ez = 0;
  }
  const d = 180 / Math.PI;
  return [ex * d, ey * d, ez * d];
}

function quatToEulerDeg(q) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m = [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
  return matrixToEulerDeg(m);
}

const deg = (v) => v.map((n) => (n >= 0 ? ' ' : '') + n.toFixed(2).padStart(7)).join(' ');

console.log(`\n${path}`);
console.log('='.repeat(78));
console.log(
  `nodes ${gltf.nodes.length} | meshes ${gltf.meshes.length} | skins ${gltf.skins?.length ?? 0} | ` +
    `animations ${gltf.animations?.length ?? 0}`
);

const scene = gltf.scenes[gltf.scene ?? 0];
console.log(
  `scene "${scene.name ?? '(unnamed)'}" roots: ` +
    scene.nodes.map((i) => gltf.nodes[i].name ?? i).join(', ')
);

console.log('\nNODE HIERARCHY (local transforms)');
console.log('-'.repeat(78));

const rotated = [];

function visit(index, parentMatrix, depth) {
  const node = gltf.nodes[index];
  const local = fromTRS(node);
  const world = multiply(parentMatrix, local);
  const name = node.name ?? `node${index}`;
  const pad = '  '.repeat(depth);

  const t = node.translation ?? [0, 0, 0];
  const q = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const euler = node.matrix ? matrixToEulerDeg(node.matrix) : quatToEulerDeg(q);

  const isIdentityRot =
    Math.abs(euler[0]) < 0.01 && Math.abs(euler[1]) < 0.01 && Math.abs(euler[2]) < 0.01;
  const isIdentityScale =
    Math.abs(s[0] - 1) < 1e-4 && Math.abs(s[1] - 1) < 1e-4 && Math.abs(s[2] - 1) < 1e-4;
  const isIdentityPos = Math.abs(t[0]) < 1e-4 && Math.abs(t[1]) < 1e-4 && Math.abs(t[2]) < 1e-4;

  let tag = '';
  if (node.mesh !== undefined) {
    const mats = gltf.meshes[node.mesh].primitives
      .map((p) => (p.material !== undefined ? gltf.materials[p.material]?.name : null))
      .filter(Boolean);
    tag += `  [mesh${node.skin !== undefined ? '+skin' : ''}${mats.length ? ': ' + mats.join(', ') : ''}]`;
  }

  console.log(`${pad}${name}${tag}`);
  if (!isIdentityPos || !isIdentityRot || !isIdentityScale) {
    console.log(
      `${pad}   local  T ${deg(t)}   R ${deg(euler)}   S ${deg(s)}` +
        `${node.matrix ? '   (authored as a matrix)' : ''}`
    );
  }
  if (!isIdentityRot) rotated.push({ name, euler, world: matrixToEulerDeg(world) });

  for (const child of node.children ?? []) visit(child, world, depth + 1);
}

for (const root of scene.nodes) visit(root, IDENTITY, 0);

console.log('\nNODES WITH A NON-IDENTITY ROTATION');
console.log('-'.repeat(78));
if (!rotated.length) console.log('  (none)');
for (const r of rotated) {
  console.log(`  ${r.name.padEnd(28)} local ${deg(r.euler)}   cumulative ${deg(r.world)}`);
}

console.log('\nANIMATIONS');
console.log('-'.repeat(78));
for (const clip of gltf.animations ?? []) {
  const nodes = new Set();
  const paths = new Set();
  for (const ch of clip.channels) {
    nodes.add(gltf.nodes[ch.target.node]?.name ?? `node${ch.target.node}`);
    paths.add(ch.target.path);
  }
  const dur = clip.samplers.length
    ? Math.max(...clip.samplers.map((s) => gltf.accessors[s.input]?.max?.[0] ?? 0))
    : 0;
  console.log(
    `  ${clip.name}  ${dur.toFixed(3)}s  ${clip.channels.length} channels  paths: ${[...paths].join('/')}`
  );
  console.log(
    `      targets: ${[...nodes].slice(0, 10).join(', ')}` +
      `${nodes.size > 10 ? ` … +${nodes.size - 10} more` : ''}`
  );
}

console.log('');
