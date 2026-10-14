// Standalone GLB inspector: parses the JSON chunk of a .glb and reports
// mesh/triangle/bone/animation stats plus an approximate bounding box.
// Usage: node tools/glb-inspect.mjs <file.glb> [more.glb ...]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

function parseGLB(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  const version = dv.getUint32(4, true);
  const total = dv.getUint32(8, true);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(buf.subarray(start, start + len)));
    else if (type === 0x004e4942) bin = buf.subarray(start, start + len);
    off = start + len;
  }
  return { version, json, bin };
}

function fmt(n) { return n.toLocaleString('en-US'); }

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  console.log('\n' + '='.repeat(78));
  console.log('FILE:', basename(file), `(${(buf.byteLength / 1048576).toFixed(2)} MB)`);
  console.log('='.repeat(78));
  let parsed;
  try { parsed = parseGLB(buf); } catch (e) { console.log('  ERROR:', e.message); continue; }
  const { version, json: g } = parsed;
  console.log(`glTF version ${version} | generator: ${g.asset?.generator ?? '?'} | extensions: ${(g.extensionsUsed ?? []).join(', ') || 'none'}`);

  const nodes = g.nodes ?? [];
  const meshes = g.meshes ?? [];
  const accessors = g.accessors ?? [];
  const skins = g.skins ?? [];
  const anims = g.animations ?? [];

  // ---- triangles ----
  let tris = 0, prims = 0, verts = 0;
  for (const m of meshes) {
    for (const p of m.primitives ?? []) {
      prims++;
      const pos = p.attributes?.POSITION;
      if (pos != null) verts += accessors[pos].count;
      if (p.indices != null) tris += accessors[p.indices].count / 3;
      else if (pos != null) tris += accessors[pos].count / 3;
    }
  }
  console.log(`\nMESHES: ${meshes.length}  |  primitives: ${prims}  |  triangles: ${fmt(Math.round(tris))}  |  vertices: ${fmt(verts)}`);

  // ---- world-space bbox (walk node hierarchy, apply TRS) ----
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const mul = (a, b) => { // column-major 4x4
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  };
  const trs = (n) => {
    if (n.matrix) return n.matrix;
    const t = n.translation ?? [0, 0, 0], r = n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1];
    const [x, y, z, w] = r;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
      (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
      (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
      (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
      t[0], t[1], t[2], 1,
    ];
  };
  const xform = (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
  const walk = (idx, parent) => {
    const n = nodes[idx];
    const world = mul(parent, trs(n));
    if (n.mesh != null) {
      for (const p of meshes[n.mesh].primitives ?? []) {
        const acc = accessors[p.attributes?.POSITION];
        if (!acc?.min || !acc?.max) continue;
        // 8 corners of the local AABB -> world
        for (let i = 0; i < 8; i++) {
          const c = [i & 1 ? acc.max[0] : acc.min[0], i & 2 ? acc.max[1] : acc.min[1], i & 4 ? acc.max[2] : acc.min[2]];
          const w = xform(world, c);
          for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], w[k]); box.max[k] = Math.max(box.max[k], w[k]); }
        }
      }
    }
    for (const c of n.children ?? []) walk(c, world);
  };
  const scene = g.scenes?.[g.scene ?? 0];
  for (const r of scene?.nodes ?? []) walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  if (isFinite(box.min[0])) {
    const size = box.max.map((v, i) => v - box.min[i]);
    console.log(`BBOX (world, model units): min [${box.min.map(v => v.toFixed(3))}]  max [${box.max.map(v => v.toFixed(3))}]`);
    console.log(`SIZE (W x H x D): ${size[0].toFixed(3)} x ${size[1].toFixed(3)} x ${size[2].toFixed(3)}`);
  } else {
    console.log('BBOX: could not compute');
  }

  // ---- skeleton ----
  if (skins.length) {
    for (const [si, sk] of skins.entries()) {
      const joints = sk.joints ?? [];
      console.log(`\nSKIN ${si}: ${joints.length} joints`);
      console.log('  bones:', joints.map(j => nodes[j]?.name ?? '?').join(', '));
    }
  } else console.log('\nSKIN: none (static mesh)');

  // ---- animations ----
  if (anims.length) {
    console.log(`\nANIMATIONS (${anims.length}):`);
    for (const a of anims) {
      let dur = 0;
      for (const s of a.samplers ?? []) { const acc = accessors[s.input]; if (acc?.max) dur = Math.max(dur, acc.max[0]); }
      console.log(`  - "${a.name}"  channels: ${(a.channels ?? []).length}  duration: ${dur.toFixed(2)}s`);
    }
  } else console.log('\nANIMATIONS: none');

  console.log(`\nMATERIALS (${(g.materials ?? []).length}): ${(g.materials ?? []).map(m => m.name ?? '?').join(', ')}`);
  console.log(`TEXTURES: ${(g.textures ?? []).length}  |  IMAGES: ${(g.images ?? []).length}  |  scenes: ${(g.scenes ?? []).length}`);
  console.log(`NODES (${nodes.length}): ${nodes.slice(0, 40).map(n => n.name ?? '?').join(', ')}${nodes.length > 40 ? `, ... (+${nodes.length - 40} more)` : ''}`);
}
console.log('');
