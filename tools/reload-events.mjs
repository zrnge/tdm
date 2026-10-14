// Reports when the viewmodel rifle's own bones move during each reload clip:
// `carg` (magazine), `seg` (release lever), `recam` (bolt), `gatillo` (trigger).
// These times feed VIEWMODEL.reload.events in src/config.ts.
// Usage: node tools/reload-events.mjs "public/models/ak74u__free_animation..glb"
import { readFileSync } from 'node:fs';
const buf = readFileSync(process.argv[2]);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 12, json, bin;
while (off < dv.getUint32(8, true)) { const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true), s = off + 8;
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(buf.subarray(s, s + len))); else bin = buf.subarray(s, s + len); off = s + len; }
const acc = (i) => { const a = json.accessors[i], bv = json.bufferViews[a.bufferView]; const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
  return { n, d: new Float32Array(bin.buffer.slice(bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0), bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0) + a.count * n * 4)), count: a.count }; };
for (const an of json.animations.filter(a => /RELOAD/.test(a.name))) {
  console.log('==', an.name);
  for (const ch of an.channels) {
    const name = json.nodes[ch.target.node].name;
    if (!/carg|recam|seg|gatillo|Bone_043/.test(name)) continue;
    const t = acc(an.samplers[ch.sampler].input).d, v = acc(an.samplers[ch.sampler].output);
    // movement speed per keyframe relative to the first value
    const base = Array.from(v.d.slice(0, v.n));
    const out = [];
    let prevMoving = false;
    for (let k = 0; k < v.count; k++) {
      let d = 0; for (let j = 0; j < v.n; j++) d = Math.max(d, Math.abs(v.d[k * v.n + j] - base[j]));
      const moving = d > (ch.target.path === 'rotation' ? 0.02 : 0.5);
      if (moving !== prevMoving) out.push((moving ? 'away@' : 'back@') + t[k].toFixed(2));
      prevMoving = moving;
    }
    // also report times where the per-key velocity peaks
    let peaks = []; for (let k = 1; k < v.count - 1; k++) { let d = 0; for (let j = 0; j < v.n; j++) d += (v.d[(k+1) * v.n + j] - v.d[k * v.n + j]) ** 2; peaks.push([Math.sqrt(d) / Math.max(t[k+1]-t[k],1e-3), t[k]]); }
    peaks.sort((a,b)=>b[0]-a[0]);
    console.log(name.padEnd(12), ch.target.path.padEnd(11), 'dur', t[t.length-1].toFixed(2), out.join(' '), '| fastest at', peaks.slice(0,4).map(p=>p[1].toFixed(2)).join(','));
  }
}
