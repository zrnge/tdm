/**
 * First-person viewmodel: the arms + AK-74U the player is drawn as.
 *
 * ## Why this is the player
 *
 * `ak74u__free_animation..glb` is a first-person viewmodel — a pair of arms
 * holding an AK74U. It is NOT a character: `Ch08_Body` is 1.78 m wide and 9 cm
 * tall (two outstretched arms), and the skeleton has no Hips, Spine, UpLeg or
 * Foot bones at all. So it cannot be a third-person body, and it is exactly
 * right as a first-person one. See docs/MODEL-REPORT.md.
 *
 * ## How it is drawn
 *
 * Into its OWN scene, with its OWN camera, composited over the world by
 * `Engine.setOverlay` with the depth buffer cleared in between. That is what
 * makes the weapon unable to clip into a wall: it is drawn last with no depth
 * test against the world, so no container or crate can cut through it.
 *
 * ## The transform chain
 *
 *   root    the tuned hip or ADS hold, plus bob, sway and kick. F4 edits this.
 *   orient  the AUTO-MEASURED alignment: barrel onto -Z, sights onto +Y.
 *           Derived from the posed geometry by `viewmodelAlign.ts`, never
 *           guessed. An optional manual nudge is composed on top.
 *   model   scaled so the gun is `VIEWMODEL.gunLength` metres, and offset so
 *           the Neck bone lands on `VIEWMODEL.anchor`.
 *
 * A model-space point `p` therefore reaches the camera as
 *
 *   p_cam = scale * R_root * (anchor + normalise * q * (p - neck)) + rootPos
 *
 * which is the equation both the anchor solve and the ADS solve are derived
 * from. Writing it down once is what stops the two from disagreeing.
 *
 * ## Where the sights point (the ADS solve)
 *
 * Aiming down sights has an exact answer, and it is NOT "align the barrel with
 * the camera". The eye looks THROUGH the rear notch at the front post, so the
 * sight line is the segment between those two points — and on an AK the two sit
 * at different heights above the bore, so that segment is not parallel to the
 * barrel. Aligning the barrel leaves the camera looking a fraction of a degree
 * below the notch, straight into the back of the receiver, which is precisely
 * the "I see the receiver instead of the sights" bug.
 *
 * So `solveAds()` does both halves:
 *
 *   rotation    the minimal rotation taking the measured sight axis onto -Z
 *   position    the slide that then puts the front post exactly on the axis
 *
 * Both are logged at load with the measured points, so a wrong solve is visible
 * in the console rather than only on screen.
 *
 * ## Animation
 *
 * Clips are mapped to gameplay states:
 *
 *   DRAW     spawn and weapon switch
 *   IDLE     loop when nothing else is playing
 *   SHOOT    restart on every shot, time-scaled to the weapon's fire rate
 *   RELOAD1  reload with rounds still in the magazine
 *   RELOAD2  reload from empty
 *   INSPEC   the V key
 *   OLSER    holster, played before a weapon switch
 *
 * Reload switches in under 0.05 s rather than crossfading. The rifle is skinned
 * to its OWN bones, so a crossfade between two clips is a weighted average of
 * two different gun positions — the weapon visibly drifts out of the hands
 * mid-blend. See `VIEWMODEL.clipFade`.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAMERA, PLAYER, VIEWMODEL } from '../config';
import { bobPhaseStep } from '../player/gait';
import { measureViewmodel, type ViewmodelAlignment } from './viewmodelAlign';
import type { Player } from '../player/player';

/** Which clip to play, in the model's own naming. */
export type ViewmodelClip = 'DRAW' | 'IDLE' | 'SHOOT' | 'RELOAD1' | 'RELOAD2' | 'INSPEC' | 'OLSER';

/** A plain mutable vector, so the F4 tool can edit config values in place. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The live hold transforms. Seeded from `VIEWMODEL` in config.ts and mutated in
 * place by the F4 tuning tool, so what the tool edits is exactly what is drawn.
 */
export interface ViewmodelHolds {
  hip: { position: Vec3; rotation: Vec3 };
  ads: { position: Vec3; rotation: Vec3 };
  /** Extra rotation composed on top of the auto-measured alignment, degrees. */
  orient: { rotation: Vec3 };
  scale: number;
}

/**
 * Where the sights ended up, in the VIEWMODEL CAMERA's space, after the ADS
 * solve. This is the evidence that aiming is correct: the front post must be at
 * x = 0, y = 0, and both sights must be in front of the near plane.
 */
export interface SightReport {
  rear: THREE.Vector3;
  front: THREE.Vector3;
  /** The sight axis after the solve. Must be ~(0, 0, -1). */
  axis: THREE.Vector3;
  /** Degrees between the sight axis and the camera's forward. Must be ~0. */
  offAxisDegrees: number;
  /** Front post offset from the screen centre, metres. Must be ~0. */
  frontOffset: THREE.Vector2;
  /** True when the rear notch is behind the near plane and would be clipped. */
  rearClipped: boolean;
}

export interface Viewmodel {
  /** The scene the viewmodel lives in. Hand this to `Engine.setOverlay`. */
  scene: THREE.Scene;
  /** The camera it is rendered with. Hand this to `Engine.setOverlay`. */
  camera: THREE.PerspectiveCamera;
  /** The model root, for the F4 tuning tool. */
  root: THREE.Group;
  /** The group carrying the auto-measured alignment. */
  orient: THREE.Group;
  /** Clip names found in the file, for the console report. */
  clips: string[];
  /** Live hold values. The F4 tool mutates these. */
  readonly holds: ViewmodelHolds;
  /**
   * Muzzle position in the viewmodel's own scene space, refreshed every frame by
   * re-skinning the gun's muzzle vertex — so it follows the SHOOT and RELOAD
   * animations rather than sitting at a fixed offset.
   */
  readonly muzzle: THREE.Vector3;
  /** The front sight post in root-local space, for the F4 tool. */
  readonly sightLine: THREE.Vector3;
  /** The sight axis in root-local space, for the F4 tool. */
  readonly sightAxis: THREE.Vector3;
  /** Where the sights land in camera space. Recomputed by `solveAds()`. */
  readonly sightReport: SightReport;
  /** True when the model loaded and has at least one clip. */
  readonly ready: boolean;
  /** True when the IDLE action is actually running, for the console report. */
  readonly idlePlaying: boolean;
  /** True while a reload clip is playing. Aiming and firing are blocked. */
  readonly reloading: boolean;
  /** 0..1 through the reload clip. */
  readonly reloadProgress: number;
  /** What was measured at load, for the console report. */
  readonly alignment: ViewmodelAlignment | null;
  /**
   * Re-solves the ADS hold from the measured sights. Called once at load, and
   * again by the F4 tool's `A` key.
   */
  solveAds(): void;
  /** Play the fire animation, time-scaled so it finishes within `interval`. */
  shoot(interval: number): void;
  /**
   * Plays the reload clip and returns its duration in seconds, so the weapon's
   * own timer can be driven by the ANIMATION rather than by a number in a config
   * file. Returns 0 when there is no clip, and the caller falls back to
   * `WEAPONS[id].reloadTime`.
   *
   * `empty` picks RELOAD2 (which racks the bolt and is longer) over RELOAD1.
   */
  reload(empty: boolean): number;
  /** Play DRAW: on spawn and after a weapon switch. */
  draw(): void;
  /** Play OLSER before a weapon switch. */
  holster(): void;
  /** Play INSPEC (the V key). Ignored during a reload. */
  inspect(): void;
  /** A shot was fired: kick the weapon back and up. */
  kick(): void;
  /**
   * Advances the animation and the feel (bob, sway, kick, ADS blend).
   * Call once per frame with the player's state, BEFORE anything reads
   * `muzzle` — the muzzle is refreshed here.
   */
  update(dt: number, player: Player, aiming: boolean): void;
  dispose(): void;
}

/** Smoothing that is stable regardless of frame rate. */
function damp(current: number, target: number, halfLife: number, dt: number): number {
  return target + (current - target) * Math.pow(2, -dt / halfLife);
}

/**
 * Near plane of the viewmodel camera, metres.
 *
 * Much larger than the world camera's, because the weapon is authored with the
 * eye inside its own rear housing. See the comment at the camera's construction.
 */
const SELF_CLIP = 0.12;

export async function loadViewmodel(): Promise<Viewmodel | null> {
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(VIEWMODEL.url);
  } catch {
    console.error(
      `[viewmodel] ${VIEWMODEL.url} failed to load. The player is drawn as this ` +
        `model and nothing else, so the game will render with no weapon.`
    );
    return null;
  }

  // ---- its own scene and camera, so the world cannot clip it ----
  const scene = new THREE.Scene();
  scene.name = 'viewmodel-scene';
  const camera = new THREE.PerspectiveCamera(
    VIEWMODEL.fov,
    window.innerWidth / window.innerHeight,
    SELF_CLIP,
    VIEWMODEL.far
  );

  const root = new THREE.Group();
  root.name = 'viewmodel';
  scene.add(root);

  // ---- lighting ----
  // A separate scene has NO lights of its own, and a MeshStandardMaterial with
  // no light renders pure black — which is exactly what happened the first time
  // this ran: the player saw a black silhouette of arms.
  const keyLight = new THREE.DirectionalLight(0xfff2e0, 2.8);
  keyLight.position.set(-0.7, 1.1, 0.9);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x9fb8d8, 1.2);
  fillLight.position.set(1.0, -0.4, 0.7);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffd9a8, 1.6);
  rimLight.position.set(0.5, 0.7, -1.0);
  scene.add(rimLight);

  scene.add(new THREE.HemisphereLight(0xbcd0e8, 0x2a2a30, 1.3));

  const model = gltf.scene;
  const hidden: string[] = [];
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    // The viewmodel must not cast shadows into the world — it is not in the
    // world scene, and a shadow from a gun the player cannot see would be a
    // visible bug.
    m.castShadow = false;
    m.receiveShadow = false;
    // Bone-posed meshes have meaningless bind-pose bounds.
    m.frustumCulled = false;

    // Hide the materials named in config. `Magazine` on this asset is not the
    // weapon's magazine — it is 1.77 m of leftover body geometry that renders as a
    // dark slab across the right of the screen at a first-person camera. See
    // VIEWMODEL.hideMaterials.
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const names = mats.map((mat) => mat?.name ?? '');
    if (names.some((n) => VIEWMODEL.hideMaterials.some((h) => h.toLowerCase() === n.toLowerCase()))) {
      m.visible = false;
      hidden.push(m.name || '(unnamed)');
    }
  });
  if (hidden.length) {
    console.log(
      `[viewmodel] hid ${hidden.length} mesh(es) by material (${VIEWMODEL.hideMaterials.join(', ')}): ` +
        `${hidden.join(', ')}`
    );
  }

  // ---- measure the alignment from the POSED geometry ----
  // The IDLE clip is played on a throwaway mixer first, because the bind pose is
  // not the pose the player sees and its bounding box does not describe the
  // barrel. See viewmodelAlign.ts.
  const idleClip =
    gltf.animations.find((c) => c.name.toUpperCase() === 'IDLE') ?? gltf.animations[0] ?? null;
  const alignment = measureViewmodel(model, idleClip);

  for (const line of alignment.log) console.log(`[viewmodel] ${line}`);

  // ---- build the chain: root -> orient -> model ----
  const orient = new THREE.Group();
  orient.name = 'viewmodel-orient';
  orient.quaternion.copy(alignment.quaternion);
  orient.add(model);
  root.add(orient);

  // ---- normalise scale so the GUN is the right length ----
  // Normalising the gun rather than the whole model matters: the arms reach
  // further than the barrel, so normalising everything would make the weapon's
  // apparent size depend on the animation pose.
  const normalise = alignment.gunExtent > 1e-4 ? VIEWMODEL.gunLength / alignment.gunExtent : 1;
  model.scale.setScalar(normalise);

  // ---- anchor: put the Neck bone where the camera's head would be ----
  // Solving for model.position rather than nudging it by hand. From the chain
  // equation at the top of this file, requiring the neck to land on `anchor`:
  //   anchor = q * (normalise * neck + model.position)
  const anchor = new THREE.Vector3(VIEWMODEL.anchor.x, VIEWMODEL.anchor.y, VIEWMODEL.anchor.z);
  const inverseAlign = alignment.quaternion.clone().invert();
  model.position
    .copy(anchor)
    .applyQuaternion(inverseAlign)
    .addScaledVector(alignment.neck, -normalise);

  // ---- the front post and the sight axis, in ROOT space ----
  // From the chain equation, a model point `p` sits at
  //   anchor + normalise * q * (p - neck)
  // in root-local space. Both the ADS solve and the F4 tool need these.
  const sightLine = new THREE.Vector3()
    .copy(alignment.frontSight)
    .sub(alignment.neck)
    .multiplyScalar(normalise)
    .applyQuaternion(alignment.quaternion)
    .add(anchor);

  const sightAxis = alignment.sightAxis.clone().applyQuaternion(alignment.quaternion).normalize();

  // ---- animation ----
  const mixer = new THREE.AnimationMixer(model);
  const byName = new Map<string, THREE.AnimationClip>();
  for (const clip of gltf.animations) byName.set(clip.name.toUpperCase(), clip);

  const actions = new Map<ViewmodelClip, THREE.AnimationAction>();
  for (const [key, clip] of byName) {
    if (isClipName(key)) {
      const action = mixer.clipAction(clip);
      actions.set(key, action);
    }
  }

  const idle = actions.get('IDLE');
  if (idle) {
    idle.setLoop(THREE.LoopRepeat, Infinity);
    idle.setEffectiveWeight(1);
    idle.play();
  }

  // ---- one-shot handling ----
  let oneShot: THREE.AnimationAction | null = null;
  let oneShotName: ViewmodelClip | null = null;

  mixer.addEventListener('finished', (e) => {
    if (e.action !== oneShot) return;
    // The rifle is skinned to its own bones, so blending the finished pose back
    // onto the idle loop is a weighted average of two gun positions. A reload
    // therefore returns to idle almost instantly; the longer fades are for clips
    // that end near the idle pose anyway.
    const fade =
      oneShotName === 'RELOAD1' || oneShotName === 'RELOAD2'
        ? VIEWMODEL.clipFade.reload
        : VIEWMODEL.clipFade.idle;
    oneShot = null;
    oneShotName = null;
    // `clampWhenFinished` holds the last frame at full weight, so the finished
    // clip must be faded out explicitly — otherwise idle is averaged with it.
    e.action.fadeOut(fade);
    if (idle) idle.reset().setEffectiveWeight(1).fadeIn(fade).play();
  });

  // `fade` is annotated `number` on purpose: `VIEWMODEL` is `as const`, so the
  // default would otherwise be inferred as the literal type `0.05` and no other
  // fade length could be passed.
  function playOnce(clip: ViewmodelClip, timeScale = 1, fade: number = VIEWMODEL.clipFade.draw) {
    const action = actions.get(clip);
    if (!action) return false;
    if (oneShot === action && action.isRunning()) {
      // Re-triggering the same clip (a fast fire rate) must restart it, not
      // stack a second instance.
      action.reset().play();
      action.setEffectiveTimeScale(timeScale);
      return true;
    }
    // Every other clip still in the mixer — the idle loop, and any one-shot held
    // on its clamped last frame — must fade out, or the mixer averages it with
    // this one and the hands and magazine drift apart.
    for (const other of actions.values()) {
      if (other !== action && other.isScheduled()) other.fadeOut(fade);
    }
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveTimeScale(timeScale);
    action.setEffectiveWeight(1);
    action.fadeIn(fade).play();
    oneShot = action;
    oneShotName = clip;
    return true;
  }

  const ready = actions.size > 0;

  // ---- live holds, seeded from config ----
  const holds: ViewmodelHolds = {
    hip: {
      position: { ...VIEWMODEL.hip.position },
      rotation: { ...VIEWMODEL.hip.rotation },
    },
    ads: {
      position: { ...VIEWMODEL.ads.position },
      rotation: { ...VIEWMODEL.ads.rotation },
    },
    orient: { rotation: { ...VIEWMODEL.orient.rotation } },
    scale: VIEWMODEL.scale,
  };

  // ---- where the sights land in camera space ----
  const sightReport: SightReport = {
    rear: new THREE.Vector3(),
    front: new THREE.Vector3(),
    axis: new THREE.Vector3(0, 0, -1),
    offAxisDegrees: 0,
    frontOffset: new THREE.Vector2(),
    rearClipped: false,
  };

  /**
   * Solves the ADS hold so the eye looks through the notch at the front post.
   *
   * From the chain equation, with the root at `adsPos` and rotated by `adsRot`:
   *
   *   front post at  scale * R * F + adsPos        where F is the front post in
   *   sight axis  =  R * A                        root-local space, A the axis
   *
   * Requiring the axis to land on the camera's -Z gives R directly, as the
   * minimal rotation from A to (0, 0, -1). Requiring the front post to land on
   * that same axis then gives the slide:
   *
   *   adsPos.x = -scale * (R * F).x
   *   adsPos.y = -scale * (R * F).y
   *
   * `adsPos.z` is left alone: it is the one value that must be set by eye, and it
   * is what controls how far the receiver sits from the eye.
   */
  function solveAds() {
    const A = sightAxis.clone();
    const F = sightLine.clone();

    // Minimal rotation from the measured sight axis onto the camera's forward.
    const q = new THREE.Quaternion().setFromUnitVectors(A, new THREE.Vector3(0, 0, -1));

    const rotated = F.clone().applyQuaternion(q);
    holds.ads.position.x = -rotated.x * holds.scale;
    holds.ads.position.y = -rotated.y * holds.scale;

    const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    holds.ads.rotation.x = THREE.MathUtils.radToDeg(euler.x);
    holds.ads.rotation.y = THREE.MathUtils.radToDeg(euler.y);
    holds.ads.rotation.z = THREE.MathUtils.radToDeg(euler.z);

    // ---- report where the sights now sit, in camera space ----
    // This is the evidence, not a claim: the front post must be at x = 0, y = 0.
    const rootQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(holds.ads.rotation.x),
        THREE.MathUtils.degToRad(holds.ads.rotation.y),
        THREE.MathUtils.degToRad(holds.ads.rotation.z)
      )
    );
    const rootPos = new THREE.Vector3(
      holds.ads.position.x,
      holds.ads.position.y,
      holds.ads.position.z
    );

    const toCamera = (p: THREE.Vector3) =>
      p.clone().multiplyScalar(holds.scale).applyQuaternion(rootQuat).add(rootPos);

    const rearRoot = new THREE.Vector3()
      .copy(alignment.rearSight)
      .sub(alignment.neck)
      .multiplyScalar(normalise)
      .applyQuaternion(alignment.quaternion)
      .add(anchor);

    sightReport.front.copy(toCamera(F));
    sightReport.rear.copy(toCamera(rearRoot));
    sightReport.axis.copy(A).applyQuaternion(rootQuat).normalize();
    sightReport.offAxisDegrees =
      (Math.acos(THREE.MathUtils.clamp(sightReport.axis.dot(FORWARD), -1, 1)) * 180) / Math.PI;
    sightReport.frontOffset.set(sightReport.front.x, sightReport.front.y);
    sightReport.rearClipped = sightReport.rear.z > -SELF_CLIP;

    console.log(
      `[viewmodel] ADS solved — rotation ` +
        `[${holds.ads.rotation.x.toFixed(2)}, ${holds.ads.rotation.y.toFixed(2)}, ` +
        `${holds.ads.rotation.z.toFixed(2)}]° position ` +
        `[${holds.ads.position.x.toFixed(4)}, ${holds.ads.position.y.toFixed(4)}, ` +
        `${holds.ads.position.z.toFixed(4)}]`
    );
    console.log(
      `[viewmodel] sights in camera space — rear ` +
        `[${sightReport.rear.x.toFixed(4)}, ${sightReport.rear.y.toFixed(4)}, ` +
        `${sightReport.rear.z.toFixed(4)}] front ` +
        `[${sightReport.front.x.toFixed(4)}, ${sightReport.front.y.toFixed(4)}, ` +
        `${sightReport.front.z.toFixed(4)}]`
    );
    console.log(
      `[viewmodel] sight axis in camera space ` +
        `[${sightReport.axis.x.toFixed(4)}, ${sightReport.axis.y.toFixed(4)}, ` +
        `${sightReport.axis.z.toFixed(4)}] = ${sightReport.offAxisDegrees.toFixed(3)}° off the ` +
        `camera forward | front post ${sightReport.frontOffset.length().toFixed(4)} m from centre` +
        (sightReport.rearClipped
          ? ` | WARNING: the rear notch is inside the ${SELF_CLIP} m near plane and will be clipped — ` +
            `make ads.position.z more negative`
          : '')
    );
  }

  if (VIEWMODEL.ads.sightAlign) {
    solveAds();
  } else {
    console.log('[viewmodel] ADS sight alignment disabled in config — using the hand-tuned hold');
  }

  if (VIEWMODEL.hip.autoFromAds) {
    const o = VIEWMODEL.hip.offset;
    const r = VIEWMODEL.hip.rotationOffset;
    holds.hip.position.x = holds.ads.position.x + o.x;
    holds.hip.position.y = holds.ads.position.y + o.y;
    holds.hip.position.z = holds.ads.position.z + o.z;
    holds.hip.rotation.x = r.x;
    holds.hip.rotation.y = r.y;
    holds.hip.rotation.z = r.z;
    console.log(
      `[viewmodel] hip derived from ADS + offset -> ` +
        `position [${holds.hip.position.x.toFixed(4)}, ${holds.hip.position.y.toFixed(4)}, ` +
        `${holds.hip.position.z.toFixed(4)}] rotation [${r.x}, ${r.y}, ${r.z}]`
    );
  }

  // ---- the muzzle, re-skinned from the gun mesh every frame ----
  const muzzle = alignment.muzzle.clone();
  const gunMesh = alignment.gunMesh;
  const muzzleVertex = alignment.muzzleVertex;

  console.log(
    `[viewmodel] ${VIEWMODEL.url} loaded | gun ${alignment.gunExtent.toFixed(3)} units -> ` +
      `normalise x${normalise.toFixed(4)} | clips: ${gltf.animations.map((c) => c.name).join(', ') || '(none)'}`
  );
  if (!ready) {
    console.error(
      '[viewmodel] no animation clips matched. Expected DRAW/IDLE/SHOOT/RELOAD1/RELOAD2/INSPEC/OLSER.'
    );
  }
  if (!idleClip) {
    console.warn('[viewmodel] no IDLE clip — the alignment was measured from the bind pose.');
  }
  if (!gunMesh) {
    console.warn('[viewmodel] no gun mesh identified — the muzzle will not track the animation.');
  }

  // ---- feel state ----
  let adsBlend = 0;
  let bobPhase = 0;
  let bobAmount = 0;
  let swayX = 0;
  let swayY = 0;
  let swayRoll = 0;
  let kickBack = 0;
  let kickPitch = 0;
  let kickRoll = 0;
  let lastYaw = 0;
  let lastPitch = 0;

  const hold = new THREE.Vector3();
  const hipPos = new THREE.Vector3();
  const adsPos = new THREE.Vector3();
  const orientEuler = new THREE.Euler();
  const orientQuat = new THREE.Quaternion();

  /** True while a reload clip is the active one-shot. */
  function isReloading(): boolean {
    return (
      oneShot !== null &&
      oneShot.isRunning() &&
      (oneShotName === 'RELOAD1' || oneShotName === 'RELOAD2')
    );
  }

  function update(dt: number, player: Player, aiming: boolean) {
    mixer.update(dt);

    const reloading = isReloading();

    // ---- ADS blend ----
    // ~0.2 s to full ADS, shared with the camera's FOV zoom so the two cannot
    // drift apart.
    adsBlend = damp(adsBlend, aiming ? 1 : 0, CAMERA.adsHalfLife, dt);

    // ---- bob: on the same footstep cadence as the camera (gait.ts) ----
    // The amplitude tracks ACTUAL speed rather than a walk/sprint flag, so it
    // eases in as the player accelerates and out as they stop. The rate rises
    // only gently with speed, as a real runner's cadence does, so a sprint
    // sways the weapon rather than shaking it.
    const speed = player.speed;
    if (player.grounded && speed > 0.15) {
      bobPhase += bobPhaseStep(speed, dt);
      const target = THREE.MathUtils.clamp(speed / PLAYER.walkSpeed, 0, VIEWMODEL.bob.sprintScale);
      bobAmount = damp(bobAmount, target, 0.12, dt);
    } else {
      bobAmount = damp(bobAmount, 0, 0.1, dt);
    }

    // A reload clip moves the arms deliberately; letting the walk bob ride on
    // top of it drags the hands off the magazine well.
    const feelScale = reloading ? VIEWMODEL.reload.bobScale : 1;

    const bobY = Math.sin(bobPhase * 2) * VIEWMODEL.bob.amplitude * bobAmount * feelScale;
    const bobX =
      Math.sin(bobPhase) *
      VIEWMODEL.bob.amplitude *
      VIEWMODEL.bob.lateralScale *
      bobAmount *
      feelScale;

    // ---- sway: the weapon lags behind the mouse, then settles ----
    // Driven from the change in the player's own angles, which is the same signal
    // as the raw mouse delta and does not require this module to see it.
    const yawDelta = player.yaw - lastYaw;
    const pitchDelta = player.pitch - lastPitch;
    lastYaw = player.yaw;
    lastPitch = player.pitch;

    const invDt = 1 / Math.max(dt, 1e-4);
    const swayScale = reloading ? VIEWMODEL.reload.swayScale : 1;
    const targetSwayX = THREE.MathUtils.clamp(
      -yawDelta * invDt * VIEWMODEL.sway.positionPerPixel * 0.01,
      -VIEWMODEL.sway.maxOffset,
      VIEWMODEL.sway.maxOffset
    );
    const targetSwayY = THREE.MathUtils.clamp(
      pitchDelta * invDt * VIEWMODEL.sway.positionPerPixel * 0.01,
      -VIEWMODEL.sway.maxOffset,
      VIEWMODEL.sway.maxOffset
    );
    const targetRoll = THREE.MathUtils.clamp(
      yawDelta * invDt * VIEWMODEL.sway.rollPerPixel * 0.01,
      -VIEWMODEL.sway.maxRoll,
      VIEWMODEL.sway.maxRoll
    );
    swayX = damp(swayX, targetSwayX * swayScale, VIEWMODEL.sway.returnHalfLife, dt);
    swayY = damp(swayY, targetSwayY * swayScale, VIEWMODEL.sway.returnHalfLife, dt);
    swayRoll = damp(swayRoll, targetRoll * swayScale, VIEWMODEL.sway.returnHalfLife, dt);

    // ---- kick: recover toward zero ----
    kickBack = damp(kickBack, 0, VIEWMODEL.kick.recoverHalfLife, dt);
    kickPitch = damp(kickPitch, 0, VIEWMODEL.kick.recoverHalfLife, dt);
    kickRoll = damp(kickRoll, 0, VIEWMODEL.kick.recoverHalfLife, dt);

    // ---- compose the transform ----
    hipPos.set(holds.hip.position.x, holds.hip.position.y, holds.hip.position.z);
    adsPos.set(holds.ads.position.x, holds.ads.position.y, holds.ads.position.z);
    hold.copy(hipPos).lerp(adsPos, adsBlend);

    hold.x += bobX + swayX;
    hold.y += bobY + swayY;
    hold.z += kickBack;

    root.position.copy(hold);
    root.scale.setScalar(holds.scale);

    const hipRot = holds.hip.rotation;
    const adsRot = holds.ads.rotation;
    root.rotation.set(
      THREE.MathUtils.degToRad(hipRot.x + (adsRot.x - hipRot.x) * adsBlend) +
        THREE.MathUtils.degToRad(kickPitch),
      THREE.MathUtils.degToRad(hipRot.y + (adsRot.y - hipRot.y) * adsBlend),
      THREE.MathUtils.degToRad(hipRot.z + (adsRot.z - hipRot.z) * adsBlend) +
        THREE.MathUtils.degToRad(swayRoll + kickRoll)
    );

    // ---- the alignment, with the manual nudge composed on top ----
    const or = holds.orient.rotation;
    if (or.x || or.y || or.z) {
      orientEuler.set(
        THREE.MathUtils.degToRad(or.x),
        THREE.MathUtils.degToRad(or.y),
        THREE.MathUtils.degToRad(or.z)
      );
      orientQuat.setFromEuler(orientEuler);
      orient.quaternion.copy(orientQuat).multiply(alignment.quaternion);
    } else {
      orient.quaternion.copy(alignment.quaternion);
    }

    // ---- refresh the muzzle from the posed gun mesh ----
    // The matrices must be current BEFORE anything reads `muzzle`, because
    // `playerWeapons.ts` fires during the same frame's update, ahead of the
    // renderer's own matrix pass.
    root.updateMatrixWorld(true);
    if (gunMesh && muzzleVertex >= 0) {
      // Re-skin the single muzzle vertex. Exact for a mesh skinned across several
      // bones, and cheaper than tracking a whole bounding box.
      //
      // `getVertexPosition` returns the vertex in the mesh's LOCAL space, so it
      // is lifted by the mesh's matrix world. The viewmodel scene itself carries
      // no transform, so world space IS the scene space that `playerWeapons.ts`
      // expects — the same space the viewmodel camera views from the origin.
      gunMesh.getVertexPosition(muzzleVertex, muzzle);
      muzzle.applyMatrix4(gunMesh.matrixWorld);
    }
  }

  return {
    scene,
    camera,
    root,
    orient,
    clips: gltf.animations.map((c) => c.name),
    holds,
    get muzzle() {
      return muzzle;
    },
    get sightLine() {
      return sightLine;
    },
    get sightAxis() {
      return sightAxis;
    },
    get sightReport() {
      return sightReport;
    },
    get ready() {
      return ready;
    },
    get idlePlaying() {
      return !!idle?.isRunning();
    },
    get reloading() {
      return isReloading();
    },
    get reloadProgress() {
      if (!oneShot || !oneShotName?.startsWith('RELOAD')) return 0;
      const clip = oneShot.getClip();
      return clip.duration > 0 ? THREE.MathUtils.clamp(oneShot.time / clip.duration, 0, 1) : 0;
    },
    get alignment() {
      return alignment;
    },
    solveAds,
    shoot(interval: number) {
      // Firing is blocked by the weapon during a reload, so this should never be
      // reached mid-reload — but if it ever is, the reload must win.
      if (isReloading()) return;
      // Time-scale the clip to the fire interval so it finishes exactly as the
      // next round leaves the barrel. Clamped, because a very short interval
      // would make the animation a blur.
      const clip = actions.get('SHOOT')?.getClip();
      const timeScale =
        clip && interval > 1e-3 ? THREE.MathUtils.clamp(clip.duration / interval, 0.5, 4) : 1;
      playOnce('SHOOT', timeScale, VIEWMODEL.clipFade.shoot);
    },
    reload(empty: boolean): number {
      // Never crossfade into a reload: the rifle is driven by its own bones, so
      // blending two clips averages two different gun positions and the weapon
      // drifts out of the hands. See VIEWMODEL.clipFade.
      const name: ViewmodelClip = empty ? 'RELOAD2' : 'RELOAD1';
      const action = actions.get(name) ?? actions.get('RELOAD1');
      if (!action) return 0;
      playOnce(name, 1, VIEWMODEL.clipFade.reload);
      return action.getClip().duration;
    },
    draw() {
      playOnce('DRAW', 1, VIEWMODEL.clipFade.draw);
    },
    holster() {
      playOnce('OLSER', 1, VIEWMODEL.clipFade.holster);
    },
    inspect() {
      // A reload plays to completion; inspecting mid-reload would cut it short.
      if (isReloading()) return;
      playOnce('INSPEC', 1, VIEWMODEL.clipFade.inspect);
    },
    kick() {
      kickBack = VIEWMODEL.kick.back;
      kickPitch = VIEWMODEL.kick.pitch;
      kickRoll = (Math.random() * 2 - 1) * VIEWMODEL.kick.roll;
    },
    update,
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) mat?.dispose();
      });
      root.removeFromParent();
    },
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** True for the clip names this game drives. */
  function isClipName(name: string): name is ViewmodelClip {
    return (
      name === 'DRAW' ||
      name === 'IDLE' ||
      name === 'SHOOT' ||
      name === 'RELOAD1' ||
      name === 'RELOAD2' ||
      name === 'INSPEC' ||
      name === 'OLSER'
    );
  }
}

const FORWARD = new THREE.Vector3(0, 0, -1);
