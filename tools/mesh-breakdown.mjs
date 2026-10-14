// Per-mesh breakdown of a GLB: name, vertex count, triangles, bind-pose bounds,
// and any embedded asset metadata (author / copyright / license).
// Usage: node tools/mesh-breakdown.mjs <file.glb>
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const buf = readFileSync(process.argv[2]);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const total = dv.getUint32(8, true);
let off = 12, g = null;
while (off < total) {
  const len = dv.getUint32(off, true);
  const type = dv.getUint32(off + 4, true);
  if (type === 0x4e4f534a) g = JSON.parse(new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len)));
  off += 8 + len;
}

console.log(`FILE: ${basename(process.argv[2])}`);
console.log('\nASSET METADATA:');
console.log('  ' + JSON.stringify(g.asset, null, 2).split('\n').join('\n  '));
if (g.asset?.extras) console.log('  extras:', JSON.stringify(g.asset.extras));
for (const [i, n] of (g.nodes ?? []).entries()) {
  if (n.extras || n.extras?.author) console.log(`  node[${i}] ${n.name} extras:`, JSON.stringify(n.extras));
}

const acc = g.accessors ?? [];
const nodes = g.nodes ?? [];

// map mesh index -> node names that reference it
const meshUsers = new Map();
for (const n of nodes) {
  if (n.mesh != null) {
    if (!meshUsers.has(n.mesh)) meshUsers.set(n.mesh, []);
    meshUsers.get(n.mesh).push(n.name ?? '?');
  }
}

console.log('\nPER-MESH BREAKDOWN:');
const all = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (const [mi, m] of (g.meshes ?? []).entries()) {
  const users = (meshUsers.get(mi) ?? []).join(', ') || '(unused)';
  console.log(`\n  mesh[${mi}] "${m.name ?? '?'}"  -> nodes: ${users}`);
  for (const [pi, p] of (m.primitives ?? []).entries()) {
    const pos = acc[p.attributes.POSITION];
    const idx = p.indices != null ? acc[p.indices] : null;
    const tris = idx ? idx.count / 3 : pos.count / 3;
    const mat = p.material != null ? g.materials[p.material]?.name ?? '?' : '(none)';
    const mn = pos.min ?? [0, 0, 0], mx = pos.max ?? [0, 0, 0];
    for (let k = 0; k < 3; k++) { all.min[k] = Math.min(all.min[k], mn[k]); all.max[k] = Math.max(all.max[k], mx[k]); }
    const size = mx.map((v, k) => v - mn[k]);
    console.log(`    prim[${pi}]  mat="${mat}"  verts=${pos.count.toLocaleString('en-US')}  tris=${Math.round(tris).toLocaleString('en-US')}`);
    console.log(`              local bbox min=[${mn.map((v) => v.toFixed(3))}] max=[${mx.map((v) => v.toFixed(3))}]`);
    console.log(`              local size  W x H x D = ${size.map((v) => v.toFixed(3)).join(' x ')}`);
  }
}
console.log(`\n  COMBINED bind-pose size: ${all.max.map((v, k) => (v - all.min[k]).toFixed(3)).join(' x ')}`);
