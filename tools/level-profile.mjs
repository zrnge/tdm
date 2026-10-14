// Level clearance probe.
//
// Reads the warehouse GLB, walks the node hierarchy to world space, and reports
// two things the cover layout depends on and that cannot be guessed:
//
//   1. ROOF PROFILE  — max vertex height per X bin. The roof is arched, so the
//                      usable headroom shrinks toward the walls. Anything placed
//                      near a wall must fit under the local roof height, not
//                      under the 5.02 m peak.
//   2. WALL FACES    — the innermost X of geometry in a walking-height band,
//                      which is where the actual interior wall surface is
//                      (the outer bbox includes wall thickness and trim).
//
// Usage: node tools/level-profile.mjs <file.glb> [materialName]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const file = process.argv[2];
const wantMaterial = process.argv[3] ?? 'Metal';

const buf = readFileSync(file);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const total = dv.getUint32(8, true);
let off = 12;
let g = null;
let bin = null;
while (off < total) {
  const len = dv.getUint32(off, true);
  const type = dv.getUint32(off + 4, true);
  const start = off + 8;
  if (type === 0x4e4f534a) g = JSON.parse(new TextDecoder().decode(buf.subarray(start, start + len)));
  else if (type === 0x004e4942) bin = buf.subarray(start, start + len);
  off = start + len;
}

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(i) {
  const a = g.accessors[i];
  const bv = g.bufferViews[a.bufferView];
  const TA = COMP[a.componentType];
  const n = NUM[a.type];
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = bv.byteStride ?? 0;
  const out = new Float64Array(a.count * n);
  if (stride && stride !== n * TA.BYTES_PER_ELEMENT) {
    for (let e = 0; e < a.count; e++) {
      const base = start + e * stride;
      const view = new TA(bin.buffer, bin.byteOffset + base, n);
      for (let k = 0; k < n; k++) out[e * n + k] = view[k];
    }
  } else {
    const view = new TA(bin.buffer, bin.byteOffset + start, a.count * n);
    for (let k = 0; k < out.length; k++) out[k] = view[k];
  }
  return out;
}

const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
};
const trs = (n) => {
  if (n.matrix) return n.matrix;
  const t = n.translation ?? [0, 0, 0];
  const r = n.rotation ?? [0, 0, 0, 1];
  const s = n.scale ?? [1, 1, 1];
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
const xf = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

const nodes = g.nodes ?? [];
const meshes = g.meshes ?? [];
const world = []; // { x, y, z }

const walk = (idx, parent) => {
  const n = nodes[idx];
  const m = mul(parent, trs(n));
  if (n.mesh != null) {
    for (const p of meshes[n.mesh].primitives ?? []) {
      const matName = p.material != null ? g.materials[p.material]?.name ?? '?' : '(none)';
      if (wantMaterial !== '*' && matName !== wantMaterial) continue;
      const pos = readAccessor(p.attributes.POSITION);
      for (let i = 0; i < pos.length; i += 3) {
        const w = xf(m, [pos[i], pos[i + 1], pos[i + 2]]);
        world.push(w[0], w[1], w[2]);
      }
    }
  }
  for (const c of n.children ?? []) walk(c, m);
};
const scene = g.scenes?.[g.scene ?? 0];
for (const r of scene?.nodes ?? []) walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let i = 0; i < world.length; i += 3) {
  minX = Math.min(minX, world[i]); maxX = Math.max(maxX, world[i]);
  minY = Math.min(minY, world[i + 1]); maxY = Math.max(maxY, world[i + 1]);
  minZ = Math.min(minZ, world[i + 2]); maxZ = Math.max(maxZ, world[i + 2]);
}

console.log(`FILE: ${basename(file)}  material="${wantMaterial}"`);
console.log(`vertices sampled: ${(world.length / 3).toLocaleString('en-US')}`);
console.log(`RAW BBOX  X [${minX.toFixed(3)}, ${maxX.toFixed(3)}]  Y [${minY.toFixed(3)}, ${maxY.toFixed(3)}]  Z [${minZ.toFixed(3)}, ${maxZ.toFixed(3)}]`);

// ---- re-centre exactly as src/level/level.ts does: (0,0,0) = middle of floor ----
const cx = (minX + maxX) / 2;
const cz = (minZ + maxZ) / 2;
const fy = minY;
const W = maxX - minX;
const D = maxZ - minZ;
console.log(`CENTRED   interior ${W.toFixed(3)} (X) x ${D.toFixed(3)} (Z) x ${(maxY - minY).toFixed(3)} (Y)`);
console.log(`          half-extents X +/-${(W / 2).toFixed(3)}  Z +/-${(D / 2).toFixed(3)}`);

// ---- roof profile: max Y per X bin, in centred coords ----
const BINS = 32;
const roof = new Array(BINS).fill(-Infinity);
for (let i = 0; i < world.length; i += 3) {
  const x = world[i] - cx;
  const y = world[i + 1] - fy;
  const b = Math.min(BINS - 1, Math.max(0, Math.floor(((x + W / 2) / W) * BINS)));
  roof[b] = Math.max(roof[b], y);
}

console.log(`\nROOF PROFILE (max height per X bin, centred coords):`);
console.log(`  bin   xFrom    xTo     maxY`);
for (let b = 0; b < BINS; b++) {
  const x0 = -W / 2 + (W * b) / BINS;
  const x1 = -W / 2 + (W * (b + 1)) / BINS;
  const bar = roof[b] === -Infinity ? '(empty)' : roof[b].toFixed(3);
  console.log(`  ${String(b).padStart(3)}  ${x0.toFixed(2).padStart(6)}  ${x1.toFixed(2).padStart(6)}   ${bar}`);
}

// ---- wall faces: innermost X of geometry inside a walking-height band ----
const BAND_LO = 0.25;
const BAND_HI = 2.6;
let wallLeft = Infinity;
let wallRight = -Infinity;
for (let i = 0; i < world.length; i += 3) {
  const y = world[i + 1] - fy;
  if (y < BAND_LO || y > BAND_HI) continue;
  const x = world[i] - cx;
  wallLeft = Math.min(wallLeft, x);
  wallRight = Math.max(wallRight, x);
}
console.log(`\nWALL FACES (geometry between y=${BAND_LO} and y=${BAND_HI} m):`);
console.log(`  innermost X  left ${wallLeft.toFixed(3)}   right ${wallRight.toFixed(3)}`);
console.log(`  -> usable interior width at walking height: ${(wallRight - wallLeft).toFixed(3)} m`);

// ---- end walls: innermost Z in the same band ----
let endNear = Infinity;
let endFar = -Infinity;
for (let i = 0; i < world.length; i += 3) {
  const y = world[i + 1] - fy;
  if (y < BAND_LO || y > BAND_HI) continue;
  const z = world[i + 2] - cz;
  endNear = Math.min(endNear, z);
  endFar = Math.max(endFar, z);
}
console.log(`  innermost Z  near ${endNear.toFixed(3)}   far ${endFar.toFixed(3)}`);
console.log(`  -> usable interior depth at walking height: ${(endFar - endNear).toFixed(3)} m`);
