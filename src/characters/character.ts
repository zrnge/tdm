/**
 * Character factory.
 *
 * Every combatant in the match is built from one of two rigs behind a single
 * `CharacterRig` interface:
 *
 *   - `createSoldierRig`  — a rigged soldier GLB (`CHARACTER.soldierUrl`),
 *                            animated from the clips it ships with.
 *   - `createBlockoutRig` — the procedural stand-in from `rig.ts`, used when
 *                            that file is absent.
 *
 * Both expose the same plain bone names (`Hips`, `Spine1`, `Head`, ...), so
 * animation, headshot detection, team tinting and the rifle attachment all work
 * unchanged either way. That is the whole point of the interface: the game is
 * never blocked on an asset.
 *
 * Each character gets its own `SkeletonUtils.clone()` of the loaded model and
 * its own `AnimationMixer`.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { CHARACTER, RIFLE, TEAM, type TeamId } from '../config';
import { createCharacterRig, type CharacterRig } from './rig';
import { createAnimator, resolveClips, type ClipSet } from './animation';
import { rifleMaterial, type RifleAsset } from '../weapons/rifleAsset';

/** A loaded soldier model, ready to be cloned per character. */
export interface SoldierSource {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** Uniform scale that brings the model to CHARACTER.height metres. */
  scale: number;
  /** Vertical offset that puts the feet on y = 0. */
  footOffset: number;
  /** Hips position in raw model space, so the body can be centred on the capsule. */
  centre: THREE.Vector3;
  /** Yaw that turns the model to face -Z, the game's forward. Radians. */
  yawOffset: number;
  height: number;
  /** Triangle count, for the console report. */
  triangles: number;
  /** Clips by game slot, with measured locomotion speeds. */
  clips: ClipSet;
  /** The barrel tip, in the gun bone's local space. Null if no gun was found. */
  muzzle: { bone: string; local: THREE.Vector3 } | null;
  /** True when the model carries its own weapon, so no rifle is attached. */
  hasOwnWeapon: boolean;
}

/**
 * Strips rig-specific decoration from a bone name so consumers can ask for
 * plain `Hips`, `Head`, `RightHand`:
 *
 *   mixamorigHips, mixamorig7:Hips  -> Hips     (Mixamo namespaces)
 *   Bind_Hips_03_00                 -> Hips     (Sketchfab re-export)
 */
export function cleanBoneName(name: string): string {
  return name
    .replace(/^mixamorig\d*:?/i, '')
    .replace(/^Bind_/, '')
    .replace(/(_\d+)+$/, '');
}

function boneMap(root: THREE.Object3D): Record<string, THREE.Object3D> {
  const bones: Record<string, THREE.Object3D> = {};
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones[cleanBoneName(o.name)] = o;
  });
  return bones;
}

const WEAPON_NAME = /gun|weapon|rifle/i;

/**
 * True for a mesh that is the model's own weapon. The flag is set at load time
 * from the glTF MESH name (e.g. `gun_gun_0_gun_0`), because the scene object is
 * named after its node (`Object_10`) and an imported gun is often skinned
 * entirely to the hand bone, so neither says "gun" on its own.
 */
function isWeaponMesh(mesh: THREE.Mesh): boolean {
  if (mesh.userData.weapon) return true;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return WEAPON_NAME.test(mesh.name) || mats.some((m) => WEAPON_NAME.test(m.name));
}

/** The bone most of a skinned mesh's first vertices are bound to. */
function dominantBone(mesh: THREE.SkinnedMesh): THREE.Bone | null {
  const index = mesh.geometry.getAttribute('skinIndex');
  const weight = mesh.geometry.getAttribute('skinWeight');
  if (!index || !weight) return null;
  const votes = new Map<number, number>();
  const n = Math.min(index.count, 64);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 4; j++) {
      const b = index.getComponent(i, j);
      votes.set(b, (votes.get(b) ?? 0) + weight.getComponent(i, j));
    }
  }
  let best = -1;
  let bestW = -1;
  for (const [b, w] of votes) if (w > bestW) [best, bestW] = [b, w];
  return mesh.skeleton.bones[best] ?? null;
}

/**
 * Measures the things a model does not state outright, by posing a throwaway
 * clone with its own clips:
 *
 *   - which way it faces (from toe-minus-ankle while walking);
 *   - each locomotion clip's natural ground speed (from the planted foot);
 *   - where its gun's muzzle is (the barrel vertex furthest forward).
 */
function analyseSoldier(scene: THREE.Object3D, animations: THREE.AnimationClip[], scale: number) {
  const probe = cloneSkeleton(scene);
  probe.updateMatrixWorld(true);
  const bones = boneMap(probe);
  const mixer = new THREE.AnimationMixer(probe);
  const names = CHARACTER.animation.clips;

  const pose = (clip: THREE.AnimationClip, t: number) => {
    mixer.stopAllAction();
    mixer.clipAction(clip).reset().play();
    mixer.setTime(t);
    probe.updateMatrixWorld(true);
  };

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  // ---- facing ----
  const forward = new THREE.Vector3(0, 0, 1); // glTF convention, if unmeasurable
  const walk = THREE.AnimationClip.findByName(animations, names.walk);
  const feet = [bones.LeftFoot, bones.RightFoot];
  const toes = [bones.LeftToeBase, bones.RightToeBase];
  if (walk && feet.every(Boolean) && toes.every(Boolean)) {
    forward.set(0, 0, 0);
    for (let i = 0; i < 8; i++) {
      pose(walk, (walk.duration * i) / 8);
      for (let f = 0; f < 2; f++) {
        toes[f].getWorldPosition(a);
        feet[f].getWorldPosition(b);
        forward.add(a.sub(b).setY(0));
      }
    }
    if (forward.lengthSq() < 1e-10) forward.set(0, 0, 1);
    forward.normalize();
  }
  // Rotating by θ about +Y moves atan2(x, z) by θ; the game's forward is -Z (π).
  const yawOffset = Math.PI - Math.atan2(forward.x, forward.z);
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));

  // ---- locomotion speed ----
  // While a foot is planted it moves backwards relative to the body at exactly
  // the body's ground speed, so the lower foot's velocity IS the clip's speed.
  const measure = (clip: THREE.AnimationClip, axisName: 'forward' | 'right'): number => {
    if (!feet.every(Boolean)) return 0;
    const axis = axisName === 'forward' ? forward : right;
    const N = 48;
    const step = clip.duration / N;
    const ys: number[][] = [];
    const ps: number[][] = [];
    for (let i = 0; i <= N; i++) {
      pose(clip, Math.min(i * step, clip.duration - 1e-4));
      ys.push([]);
      ps.push([]);
      for (const foot of feet) {
        foot.getWorldPosition(a);
        ys[i].push(a.y);
        ps[i].push(a.dot(axis));
      }
    }
    const speeds: number[] = [];
    for (let i = 0; i < N; i++) {
      const low = ys[i][0] < ys[i][1] ? 0 : 1;
      const lowNext = ys[i + 1][0] < ys[i + 1][1] ? 0 : 1;
      if (low !== lowNext) continue;
      speeds.push(Math.abs(ps[i + 1][low] - ps[i][low]) / step);
    }
    if (!speeds.length) return 0;
    speeds.sort((x, y) => x - y);
    return speeds[Math.floor(speeds.length / 2)] * scale;
  };
  const clips = resolveClips(animations, measure);

  // ---- muzzle ----
  let muzzle: SoldierSource['muzzle'] = null;
  let hasOwnWeapon = false;
  const aimClip = clips.clips.aim ?? clips.clips.idle;
  if (aimClip) pose(aimClip, 0);
  probe.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || muzzle) return;
    if (!isWeaponMesh(mesh)) return;
    hasOwnWeapon = true;
    // The muzzle is stored relative to whichever bone carries the gun — its own
    // bone, or the hand it is skinned to.
    const bone = dominantBone(mesh);
    if (!bone) return;
    // The barrel tip is the gun vertex furthest along the facing.
    const count = mesh.geometry.getAttribute('position').count;
    let bestDot = -Infinity;
    const tip = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, a);
      a.applyMatrix4(mesh.matrixWorld);
      const d = a.dot(forward);
      if (d > bestDot) {
        bestDot = d;
        tip.copy(a);
      }
    }
    muzzle = { bone: bone.name, local: bone.worldToLocal(tip) };
  });

  mixer.stopAllAction();
  mixer.uncacheRoot(probe);
  return { yawOffset, clips, muzzle: muzzle as SoldierSource['muzzle'], hasOwnWeapon };
}

/**
 * Loads `CHARACTER.soldierUrl` if it exists.
 *
 * Returns `null` when the file is missing, which is NOT an error: the game
 * falls back to the blockout rig.
 */
export async function loadSoldierSource(): Promise<SoldierSource | null> {
  const loader = new GLTFLoader();
  let gltf: Awaited<ReturnType<GLTFLoader['loadAsync']>>;
  try {
    gltf = await loader.loadAsync(CHARACTER.soldierUrl);
  } catch {
    console.log(
      `[soldier] ${CHARACTER.soldierUrl} not found — using the procedural blockout rig.`
    );
    return null;
  }

  const scene = gltf.scene;
  scene.updateMatrixWorld(true);

  // Tag the model's own weapon by its glTF mesh name; see `isWeaponMesh`.
  // userData survives SkeletonUtils.clone, so every character inherits the tag.
  const json = gltf.parser.json as { nodes?: { mesh?: number }[]; meshes?: { name?: string }[] };
  scene.traverse((o) => {
    const assoc = gltf.parser.associations.get(o);
    if (!assoc) return;
    const meshIndex = assoc.meshes ?? (assoc.nodes !== undefined ? json.nodes?.[assoc.nodes]?.mesh : undefined);
    const meshName = meshIndex !== undefined ? json.meshes?.[meshIndex]?.name : undefined;
    if (meshName && WEAPON_NAME.test(meshName)) o.userData.weapon = true;
  });

  let triangles = 0;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const idx = m.geometry.getIndex();
    triangles += idx ? idx.count / 3 : m.geometry.getAttribute('position').count / 3;
    // Bone-posed meshes have meaningless bind-pose bounds.
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
  });

  const box = new THREE.Box3().setFromObject(scene);
  const rawHeight = box.max.y - box.min.y;
  const scale = rawHeight > 1e-3 ? CHARACTER.height / rawHeight : CHARACTER.soldierFallbackScale;

  const centre = new THREE.Vector3();
  const hips = boneMap(scene).Hips;
  if (hips) hips.getWorldPosition(centre);
  else box.getCenter(centre);

  const analysis = analyseSoldier(scene, gltf.animations, scale);

  const speeds = Object.entries(analysis.clips.speeds)
    .map(([k, v]) => `${k} ${v!.toFixed(2)}`)
    .join(', ');
  console.log(
    `[soldier] loaded ${CHARACTER.soldierUrl} | ${Math.round(triangles).toLocaleString('en-US')} tris | ` +
      `raw height ${rawHeight.toFixed(3)} -> scale ${scale.toFixed(4)} for ${CHARACTER.height} m | ` +
      `facing offset ${THREE.MathUtils.radToDeg(analysis.yawOffset).toFixed(0)}° | ` +
      `${Object.keys(analysis.clips.clips).length}/${Object.keys(CHARACTER.animation.clips).length} clips mapped | ` +
      `speeds m/s: ${speeds || 'n/a'} | own weapon: ${analysis.hasOwnWeapon ? 'yes' : 'no'}, ` +
      `muzzle: ${analysis.muzzle ? cleanBoneName(analysis.muzzle.bone) : 'n/a'}`
  );

  return {
    scene,
    animations: gltf.animations,
    scale,
    footOffset: -box.min.y * scale,
    centre,
    yawOffset: analysis.yawOffset,
    height: CHARACTER.height,
    triangles: Math.round(triangles),
    clips: analysis.clips,
    muzzle: analysis.muzzle,
    hasOwnWeapon: analysis.hasOwnWeapon,
  };
}

export interface CreateCharacterOptions {
  team: TeamId;
  /** Soldier model, or null to use the blockout rig. */
  soldier: SoldierSource | null;
  /** The shared rifle geometry to attach. Omit for an unarmed character. */
  rifle: RifleAsset | null;
}

export function createCharacter(opts: CreateCharacterOptions): CharacterRig {
  return opts.soldier ? createSoldierCharacter(opts) : createBlockoutCharacter(opts);
}

// ---------------------------------------------------------------------------
// Rigged soldier
// ---------------------------------------------------------------------------

/**
 * Team accent, applied as a light tint so both teams stay readable without
 * repainting the model's textures into flat plastic. The weapon is left alone.
 */
function applyTeamTint(root: THREE.Object3D, team: TeamId, disposables: THREE.Material[]) {
  const accent = new THREE.Color(TEAM[team].accent);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const isWeapon = isWeaponMesh(mesh);
    const cloned = mats.map((m) => {
      const c = (m as THREE.MeshStandardMaterial).clone();
      // Base colour only. An emissive tint, however faint, glows on its own and
      // turns every dark surface (the undersuit) a solid team colour.
      if (!isWeapon) c.color.lerp(accent, 0.25);
      disposables.push(c);
      return c;
    });
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
  });
}

function createSoldierCharacter({
  team,
  soldier,
  rifle,
}: CreateCharacterOptions): CharacterRig {
  const src = soldier!;
  const disposables: THREE.Material[] = [];
  const meshes: THREE.Mesh[] = [];

  const root = new THREE.Group();
  root.name = `character-${team}`;

  // The pivot turns the model to face -Z; the model inside is scaled, dropped
  // onto the floor and centred so its hips sit over the capsule.
  const pivot = new THREE.Group();
  pivot.rotation.y = src.yawOffset;
  root.add(pivot);

  // SkeletonUtils.clone is required: a plain Object3D.clone() shares the
  // skeleton, so all 8 characters would animate as one.
  const model = cloneSkeleton(src.scene);
  model.scale.setScalar(src.scale);
  model.position.set(-src.centre.x * src.scale, src.footOffset, -src.centre.z * src.scale);
  pivot.add(model);
  root.updateMatrixWorld(true);

  applyTeamTint(model, team, disposables);

  const bones = boneMap(model);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) meshes.push(m);
  });

  const headBone = bones.Head ?? bones.Neck ?? model;
  // A model that carries its own gun gets no second one bolted on.
  const rifleMesh = src.hasOwnWeapon ? null : attachRifle(bones, rifle, disposables);
  const animator = createAnimator(root, model, bones, src.clips);
  animator.reset();

  let muzzleBone: THREE.Object3D | undefined;
  model.traverse((o) => {
    if (src.muzzle && o.name === src.muzzle.bone) muzzleBone = o;
  });

  console.log(
    `[character] ${team} soldier | ${meshes.length} meshes | bones: ${Object.keys(bones).length} ` +
      `| head bone: ${headBone.name || '(fallback)'} | weapon: ${
        src.hasOwnWeapon ? 'model\'s own' : rifleMesh ? 'attached to ' + RIFLE_BONE : 'none'
      }`
  );

  return {
    root,
    bones,
    meshes,
    height: src.height,
    radius: 0.34,
    headBone,
    rifle: rifleMesh,
    animator,
    muzzleWorld(out) {
      if (!muzzleBone || !src.muzzle) return false;
      out.copy(src.muzzle.local);
      muzzleBone.localToWorld(out);
      return true;
    },
    dispose() {
      animator.dispose();
      for (const d of disposables) d.dispose();
      root.removeFromParent();
    },
  };
}

// ---------------------------------------------------------------------------
// Procedural blockout
// ---------------------------------------------------------------------------

function createBlockoutCharacter({ team, rifle }: CreateCharacterOptions): CharacterRig {
  const base = createCharacterRig(team);
  const disposables: THREE.Material[] = [];
  const rifleMesh = attachRifle(base.bones, rifle, disposables);

  const originalDispose = base.dispose;
  return {
    ...base,
    rifle: rifleMesh,
    dispose() {
      for (const d of disposables) d.dispose();
      originalDispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Rifle attachment
// ---------------------------------------------------------------------------

const RIFLE_BONE = 'RightHand';

/**
 * Welds the rifle to the character's right hand.
 *
 * The rifle geometry is authored in hand space — grip at the origin, barrel
 * down -Z — so this is a pure local transform. The numbers come from
 * `RIFLE.grip` in config.ts, which is tuned visually with the F5 tool rather
 * than derived, because hand bones carry their own axis convention.
 */
function attachRifle(
  bones: Record<string, THREE.Object3D>,
  rifle: RifleAsset | null,
  disposables: THREE.Material[]
): THREE.Mesh | null {
  const hand = bones[RIFLE_BONE];
  if (!rifle || !hand) return null;

  const mat = rifleMaterial();
  disposables.push(mat);

  const mesh = new THREE.Mesh(rifle.geometry, mat);
  mesh.name = 'rifle';
  mesh.castShadow = true;
  // The rifle hangs off a bone, so its bind-pose bounds are meaningless.
  mesh.frustumCulled = false;
  applyGrip(mesh);

  hand.add(mesh);
  return mesh;
}

/** Applies `RIFLE.grip` to a rifle mesh. Also used by the F5 tuning tool. */
export function applyGrip(mesh: THREE.Object3D): void {
  const { position, rotation, scale } = RIFLE.grip;
  mesh.position.set(position.x, position.y, position.z);
  mesh.rotation.set(
    THREE.MathUtils.degToRad(rotation.x),
    THREE.MathUtils.degToRad(rotation.y),
    THREE.MathUtils.degToRad(rotation.z)
  );
  mesh.scale.setScalar(scale);
}
