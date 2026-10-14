/**
 * Standalone model inspection page (inspect.html).
 *
 * Loads both supplied .glb files, prints a full report to the console and to
 * the DOM, and renders each one so scale/orientation can be eyeballed.
 * Results are also exposed on `window.__INSPECT__` for automated reading.
 *
 * View modes:  [1] character  [2] level exterior  [3] level interior
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { analyzeModel, formatStats, type ModelStats } from '../core/modelStats';

const MODELS = [
  { name: 'character (ak74u)', url: `${import.meta.env.BASE_URL}models/ak74u__free_animation..glb` },
  { name: 'level (Warehouse_FBX_Model_Free)', url: `${import.meta.env.BASE_URL}models/warehouse_fbx_model_free.glb` },
] as const;

const logEl = document.getElementById('log')!;
let html = '';

function out(text: string, cls = '') {
  html += cls ? `<span class="${cls}">${escapeHtml(text)}</span>\n` : `${escapeHtml(text)}\n`;
  logEl.innerHTML = html;
  console.log(text);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

// ---------------------------------------------------------------- renderer

const W = 760;
const H = 520;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.style.cssText =
  `position:fixed;right:14px;top:14px;width:${W}px;height:${H}px;border:1px solid #24303d;border-radius:6px;background:#111;z-index:5`;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2029);

const camera = new THREE.PerspectiveCamera(50, W / H, 0.05, 800);

scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x2a2f38, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(6, 12, 8);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
scene.add(key);
const grid = new THREE.GridHelper(40, 40, 0x3a4a5c, 0x232c36);
scene.add(grid);

// A 1.8 m reference human, so scale problems are obvious at a glance.
const ref = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.25, 1.3, 6, 12),
  new THREE.MeshStandardMaterial({ color: 0x2f6f4f, roughness: 0.9 })
);
ref.position.set(0, 0.9, 0);
scene.add(ref);

// ---------------------------------------------------------------- loading

const loader = new GLTFLoader();
const results: ModelStats[] = [];
const mixers: THREE.AnimationMixer[] = [];

let characterHolder: THREE.Group | null = null;
let levelHolder: THREE.Group | null = null;
let levelSize = new THREE.Vector3(1, 1, 1);

interface Loaded {
  root: THREE.Object3D;
  stats: ModelStats;
}

async function loadOne(name: string, url: string): Promise<Loaded | null> {
  try {
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;
    root.userData.gltf = { animations: gltf.animations };
    const stats = analyzeModel(root, name, url);
    results.push(stats);

    // Skinned meshes are posed by bones, so their bind-pose bounding volume is
    // meaningless — Three.js would cull them out of view. Disable culling.
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.frustumCulled = false;
    });

    out(formatStats(stats), 'h');
    out(`  hierarchy:      ${stats.hierarchy.join(' | ')}`, 'dim');
    if (stats.boneCount) out(`  bone names:     ${stats.bones.join(', ')}`, 'dim');
    return { root, stats };
  } catch (err) {
    out(`FAILED to load ${name} from ${url}: ${(err as Error).message}`, 'err');
    return null;
  }
}

async function main() {
  out('MODEL INSPECTION', 'h');
  out('================\n');

  const [character, level] = await Promise.all([
    loadOne(MODELS[0].name, MODELS[0].url),
    loadOne(MODELS[1].name, MODELS[1].url),
  ]);

  // ---- character: normalise to 1.8 m, then show it ----
  if (character) {
    const s = character.stats;
    const height = s.bbox.size[1] || 1;
    const scale = 1.8 / height;
    out(`\nNORMALISATION (character)`, 'h');
    out(`  raw height ${height.toFixed(3)} -> scale factor ${scale.toFixed(4)} for 1.80 m`, 'ok');
    out(`  raw width x depth: ${s.bbox.size[0].toFixed(3)} x ${s.bbox.size[2].toFixed(3)}`, 'dim');

    characterHolder = new THREE.Group();
    characterHolder.name = 'character-holder';
    character.root.scale.setScalar(scale);
    character.root.position.set(
      -s.bbox.center[0] * scale,
      -s.bbox.min[1] * scale,
      -s.bbox.center[2] * scale
    );
    characterHolder.add(character.root);
    characterHolder.position.set(2.2, 0, 0);
    scene.add(characterHolder);

    const after = new THREE.Box3().setFromObject(characterHolder);
    const size = after.getSize(new THREE.Vector3());
    out(`  after normalise: ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} m`, 'ok');

    if (s.animations.length) {
      const mixer = new THREE.AnimationMixer(character.root);
      const clip = (character.root.userData.gltf as { animations: THREE.AnimationClip[] }).animations[0];
      if (clip) mixer.clipAction(clip).play();
      mixers.push(mixer);
      out(`  playing clip:   ${clip?.name}`, 'dim');
    }
  }

  // ---- level ----
  if (level) {
    const s = level.stats;
    levelHolder = new THREE.Group();
    levelHolder.name = 'level-holder';
    level.root.position.set(-s.bbox.center[0], -s.bbox.min[1], -s.bbox.center[2]);
    levelHolder.add(level.root);
    scene.add(levelHolder);
    levelSize.set(s.bbox.size[0], s.bbox.size[1], s.bbox.size[2]);

    out(`\nLEVEL FRAMING`, 'h');
    out(`  footprint: ${s.bbox.size[0].toFixed(2)} x ${s.bbox.size[2].toFixed(2)} m, height ${s.bbox.size[1].toFixed(2)} m`, 'ok');
    out(`  centred at origin, floor at y=0`, 'dim');
    out(`  NOTE: requested map was ~60 x 40 m; this model is ${s.bbox.size[0].toFixed(1)} x ${s.bbox.size[2].toFixed(1)} m`, 'warn');
  }

  out('\nView modes: [1] character  [2] level exterior  [3] level interior', 'ok');
  out('Done. Results on window.__INSPECT__', 'ok');
  (window as unknown as Record<string, unknown>).__INSPECT__ = results;
  (window as unknown as Record<string, unknown>).__INSPECT_READY__ = true;
}

// ---------------------------------------------------------------- view modes

type ViewMode = 'character' | 'level-out' | 'level-in';
let mode: ViewMode = 'character';

function applyMode() {
  if (characterHolder) characterHolder.visible = mode === 'character';
  if (levelHolder) levelHolder.visible = mode !== 'character';
  grid.visible = mode !== 'level-in';
  ref.visible = mode === 'character';

  if (mode === 'character') {
    camera.near = 0.05;
    camera.far = 200;
  } else {
    camera.near = 0.05;
    camera.far = 800;
  }
  camera.updateProjectionMatrix();
}

window.addEventListener('keydown', (e) => {
  if (e.key === '1') mode = 'character';
  else if (e.key === '2') mode = 'level-out';
  else if (e.key === '3') mode = 'level-in';
  else return;
  applyMode();
  out(`view -> ${mode}`, 'dim');
});

// ---------------------------------------------------------------- loop

let lastTime = performance.now();
let angle = 0;

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  for (const m of mixers) m.update(dt);

  if (mode === 'character') {
    angle += dt * 0.4;
    camera.position.set(2.2 + Math.cos(angle) * 3.2, 1.7, Math.sin(angle) * 3.2);
    camera.lookAt(2.2, 0.95, 0);
  } else if (mode === 'level-out') {
    angle += dt * 0.15;
    const r = Math.max(levelSize.x, levelSize.z) * 0.85;
    camera.position.set(Math.cos(angle) * r, levelSize.y * 2.4, Math.sin(angle) * r);
    camera.lookAt(0, levelSize.y * 0.4, 0);
  } else {
    // interior: slow orbit around the middle of the hall at eye height
    angle += dt * 0.12;
    const r = Math.min(levelSize.x, levelSize.z) * 0.28;
    camera.position.set(Math.cos(angle) * r, 1.65, Math.sin(angle) * r);
    camera.lookAt(Math.cos(angle + 2.2) * r, 1.5, Math.sin(angle + 2.2) * r);
  }

  renderer.render(scene, camera);
}

main().finally(() => {
  applyMode();
  tick();
});
