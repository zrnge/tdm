// Prints every node name in a GLB and flags which standard humanoid bone
// groups are present/absent. Usage: node tools/bones.mjs <file.glb>
import { readFileSync } from 'node:fs';

const buf = readFileSync(process.argv[2]);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 12, json = null;
const total = dv.getUint32(8, true);
while (off < total) {
  const len = dv.getUint32(off, true);
  const type = dv.getUint32(off + 4, true);
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len)));
  off += 8 + len;
}
const g = json;
const names = (g.nodes ?? []).map((n) => n.name ?? '?');
console.log(`ALL ${names.length} NODES:\n`);
names.forEach((n, i) => console.log(`  ${String(i).padStart(3)}  ${n}`));

const lower = names.map((n) => n.toLowerCase());
const groups = {
  Hips: ['hips', 'pelvis', 'root_joint'],
  Spine: ['spine'],
  Legs: ['upleg', 'thigh', 'leg', 'foot', 'toe'],
  Arms: ['shoulder', 'arm', 'forearm', 'hand'],
  Fingers: ['thumb', 'index', 'middle', 'ring', 'pinky'],
  Head: ['head', 'neck'],
  WeaponBones: ['carg', 'recam', 'seg', 'gatillo', 'mag', 'bolt', 'trigger'],
};
console.log('\nBONE GROUP COVERAGE:');
for (const [label, keys] of Object.entries(groups)) {
  const hits = lower.filter((n) => keys.some((k) => n.includes(k)));
  console.log(`  ${label.padEnd(13)} ${hits.length ? 'YES' : 'NO '}  (${hits.length} matches)${hits.length && hits.length <= 4 ? ' -> ' + hits.join(', ') : ''}`);
}
const hasLegs = lower.some((n) => n.includes('upleg') || n.includes('thigh') || n.includes('foot'));
const hasSpine = lower.some((n) => n.includes('spine'));
const hasHips = lower.some((n) => n.includes('hips') || n.includes('pelvis'));
console.log(`\nVERDICT: ${hasHips && hasSpine && hasLegs ? 'FULL BODY skeleton' : 'PARTIAL skeleton - NOT a full-body character'}`);
