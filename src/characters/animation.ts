/**
 * Third-person character animation.
 *
 * One `AnimationMixer` per character, built on that character's own
 * `SkeletonUtils.clone()`. The clips themselves are loaded once and shared; a
 * mixer binds them to its own bones by NAME, so eight bots animate
 * independently from one set of clips.
 *
 * ## What drives what
 *
 * The bot AI owns movement; this module only reads it. Each frame it is handed
 * the bot's world velocity and facing, and picks clips for TWO LAYERS that
 * animate disjoint halves of the skeleton:
 *
 * LEGS (root, hips, legs) — movement and stance:
 *
 *   dead              -> death (once, held on the last frame)
 *   crouched          -> crouch / crouch-walk
 *   moving forward    -> walk / run
 *   moving backward   -> backpedal
 *   moving sideways   -> strafe left / right
 *   standing, engaged -> aim, or rapid fire while a burst is going
 *   standing          -> idle
 *
 * UPPER BODY (spine and up) — the legs' clip, in step, unless the hands are busy:
 *
 *   reloading         -> reload, WHATEVER the legs do (its length IS the
 *                        reload time), so a bot reloads on the run or behind a
 *                        crate instead of freezing or skating
 *   firing, moving    -> rapid fire over walking/strafing legs; run-and-shoot
 *                        when running
 *   aiming, moving    -> rifle held up rather than swinging with the walk
 *
 * ## No foot sliding
 *
 * Each locomotion clip's natural ground speed is MEASURED at load time from its
 * planted foot (see `measureClipSpeed`), and playback is scaled by
 * `actualSpeed / naturalSpeed`. A bot moving at 3 m/s with a walk authored at
 * 1.5 m/s would otherwise moonwalk. Walk <-> run switches keep the cycle phase,
 * so the feet do not hitch on the transition.
 *
 * ## Procedural layers on top
 *
 * Two small adjustments are applied to the spine AFTER the mixer, in world
 * space so they work whatever axis convention the rig's bones use:
 *
 *   - aim pitch: the chest tilts toward the target, so the barrel follows a
 *     target that is higher or lower than the bot;
 *   - flinch: a short spring-damped jolt backwards when the bot is hit.
 */
import * as THREE from 'three';
import { CHARACTER } from '../config';

/** Logical animation slots. The config maps each one to a clip name. */
export type ClipKey = keyof typeof CHARACTER.animation.clips;

const LOCOMOTION: ClipKey[] = ['walk', 'run', 'runFire', 'back', 'strafeLeft', 'strafeRight', 'crouchWalk'];
const ONE_SHOT: ClipKey[] = ['reload', 'death'];

/** Clips resolved from the loaded model, plus their measured ground speeds. */
export interface ClipSet {
  clips: Partial<Record<ClipKey, THREE.AnimationClip>>;
  /** Natural ground speed of each locomotion clip, metres per second. */
  speeds: Partial<Record<ClipKey, number>>;
}

export interface AnimationInput {
  /** World-space velocity, m/s. Only X and Z are used. */
  velocity: THREE.Vector3;
  /** Facing, radians about +Y. Yaw 0 faces -Z. */
  yaw: number;
  /** True while the bot is engaging a target it can see. */
  aiming: boolean;
  /** Pitch from the eye to the target, radians, positive up. */
  aimPitch: number;
  reloading: boolean;
  /** Crouched behind low cover. */
  crouching?: boolean;
  dead: boolean;
}

export interface CharacterAnimator {
  /** The clip the legs are playing, for the debug overlay. */
  readonly current: ClipKey | null;
  /** The clip the upper body is playing (differs while reloading or firing on the move). */
  readonly upperCurrent: ClipKey | null;
  /** Length of the reload clip in seconds, or undefined if there is none. */
  readonly reloadDuration: number | undefined;
  /** Advances the mixer and applies the procedural layers. */
  update(dt: number, input: AnimationInput): void;
  /** A round was just fired. Keeps the firing pose up for a moment. */
  fired(): void;
  /** The character was hit. `strength` is 0..1. */
  flinch(strength?: number): void;
  /** Snaps back to idle with no blend. Used on respawn. */
  reset(): void;
  dispose(): void;
}

/** Looks a clip up by its configured name and measures locomotion speeds. */
export function resolveClips(
  animations: THREE.AnimationClip[],
  measure: (clip: THREE.AnimationClip, axis: 'forward' | 'right') => number
): ClipSet {
  const set: ClipSet = { clips: {}, speeds: {} };
  const names = CHARACTER.animation.clips;
  for (const key of Object.keys(names) as ClipKey[]) {
    const clip = THREE.AnimationClip.findByName(animations, names[key]);
    if (!clip) continue;
    set.clips[key] = clip;
    if (LOCOMOTION.includes(key)) {
      const axis = key === 'strafeLeft' || key === 'strafeRight' ? 'right' : 'forward';
      set.speeds[key] = measure(clip, axis);
    }
  }
  return set;
}

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/**
 * Rotates `bone` about a WORLD-space axis, leaving the rest of its transform
 * alone. Works on any rig, whatever its bones' local axis convention.
 */
function rotateBoneWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number) {
  if (!bone.parent || Math.abs(angle) < 1e-5) return;
  bone.parent.getWorldQuaternion(_q1);
  _q2.setFromAxisAngle(axis, angle);
  // local delta = parent^-1 * worldDelta * parent
  const delta = _q1.clone().invert().multiply(_q2).multiply(_q1);
  bone.quaternion.premultiply(delta);
}

/**
 * Which half of the body a track belongs to. The upper half is the spine and
 * everything on it (neck, head, shoulders, arms, hands, the gun); the rest —
 * root, hips, legs — is the lower half.
 */
function isUpperBody(trackName: string): boolean {
  const node = trackName.slice(0, trackName.lastIndexOf('.'));
  const name = node
    .replace(/^mixamorig\d*:?/i, '')
    .replace(/^Bind_/, '')
    .replace(/(_\d+)+$/, '');
  if (/^(Left|Right)(UpLeg|Leg|Foot|ToeBase)/.test(name)) return false;
  return /^(Spine|Neck|Head|Left|Right|gun)/i.test(name);
}

/** A copy of `clip` keeping only one half of the body's tracks. */
function halfClip(clip: THREE.AnimationClip, upper: boolean): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => isUpperBody(t.name) === upper);
  return new THREE.AnimationClip(`${clip.name}:${upper ? 'upper' : 'lower'}`, clip.duration, tracks);
}

/**
 * One layer of the body: its own actions (built from half-clips) and its own
 * crossfades. The legs and the upper body are two of these, so a bot can run
 * with its legs while its arms reload or fire.
 */
function createLayer(mixer: THREE.AnimationMixer, set: ClipSet, upper: boolean) {
  const actions = new Map<ClipKey, THREE.AnimationAction>();
  for (const [key, clip] of Object.entries(set.clips) as [ClipKey, THREE.AnimationClip][]) {
    const action = mixer.clipAction(halfClip(clip, upper));
    if (ONE_SHOT.includes(key)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions.set(key, action);
  }
  let current: ClipKey | null = null;

  return {
    actions,
    get current() {
      return current;
    },
    get action() {
      return current ? actions.get(current) ?? null : null;
    },
    /** Switches to `key`, starting it at `time` if given (to stay in step). */
    play(key: ClipKey, fade: number, timeScale: number, time?: number) {
      const next = actions.get(key);
      if (!next) return;
      next.setEffectiveTimeScale(timeScale);
      if (key === current) return;
      const prev = current ? actions.get(current) : undefined;
      next.reset();
      next.setEffectiveWeight(1);
      if (time !== undefined) next.time = time % next.getClip().duration;
      else if (prev && LOCOMOTION.includes(current!) && LOCOMOTION.includes(key)) {
        // Locomotion -> locomotion keeps the cycle phase, so the feet stay in step.
        next.time = (prev.time / prev.getClip().duration) * next.getClip().duration;
      }
      next.play();
      if (prev) {
        if (fade > 0) prev.crossFadeTo(next, fade, false);
        else prev.stop();
      }
      current = key;
    },
    reset() {
      current = null;
    },
  };
}

export function createAnimator(
  root: THREE.Object3D,
  model: THREE.Object3D,
  bones: Record<string, THREE.Object3D>,
  set: ClipSet
): CharacterAnimator {
  const cfg = CHARACTER.animation;
  const mixer = new THREE.AnimationMixer(model);

  // Two layers over disjoint tracks: legs (root, hips, legs) and upper body
  // (spine and up). Normally both play the same clip in step; the upper body
  // breaks away for a reload or for firing on the move.
  const lower = createLayer(mixer, set, false);
  const upper = createLayer(mixer, set, true);

  /** Falls back down a chain so a model missing a clip still animates. */
  const FALLBACK: Partial<Record<ClipKey, ClipKey>> = {
    fire: 'aim',
    aim: 'idle',
    runFire: 'run',
    run: 'walk',
    back: 'walk',
    strafeLeft: 'walk',
    strafeRight: 'walk',
    walk: 'idle',
    crouchWalk: 'walk',
    crouch: 'idle',
  };
  function resolve(key: ClipKey): ClipKey | null {
    let k: ClipKey | undefined = key;
    while (k && !lower.actions.has(k)) k = FALLBACK[k];
    return k ?? null;
  }

  // The run threshold is the geometric mean of the two clips' natural speeds:
  // at that speed both need the same time-scale RATIO (one sped up, one slowed
  // down), so whichever clip needs the smaller correction is the one chosen.
  const walkSpeed = set.speeds.walk || 1.4;
  const runSpeed = set.speeds.run || 3.5;
  const runThreshold = Math.sqrt(walkSpeed * runSpeed);

  let fireTimer = 0;
  let pitch = 0;
  // Flinch is a damped spring: angle and angular velocity.
  let flinchAngle = 0;
  let flinchVel = 0;
  let flinchTwist = 0;

  const spineUpper = bones.Spine2 ?? bones.Spine1 ?? bones.Spine;
  const spineLower = bones.Spine1 ?? bones.Spine;
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  interface Pick {
    key: ClipKey;
    timeScale: number;
  }

  /** What the LEGS do: driven by movement and stance only. */
  function chooseLegs(input: AnimationInput, speed: number): Pick {
    if (input.dead) return { key: 'death', timeScale: 1 };
    const vx = input.velocity.x;
    const vz = input.velocity.z;

    if (input.crouching) {
      if (speed > cfg.moveThreshold) {
        const natural = set.speeds.crouchWalk || walkSpeed;
        return {
          key: 'crouchWalk',
          timeScale: THREE.MathUtils.clamp(speed / natural, cfg.minTimeScale, cfg.maxTimeScale),
        };
      }
      return { key: 'crouch', timeScale: 1 };
    }

    if (speed > cfg.moveThreshold) {
      // Velocity in the character's own frame. Yaw 0 faces -Z.
      const fx = -Math.sin(input.yaw);
      const fz = -Math.cos(input.yaw);
      const forward = vx * fx + vz * fz;
      const side = vx * -fz + vz * fx; // +right

      let key: ClipKey;
      if (forward >= Math.abs(side) * 0.75) key = speed >= runThreshold ? 'run' : 'walk';
      else if (forward <= -Math.abs(side) * 0.75) key = 'back';
      else key = side > 0 ? 'strafeRight' : 'strafeLeft';

      const resolved = resolve(key) ?? key;
      const natural =
        set.speeds[resolved] || (resolved === 'run' || resolved === 'runFire' ? runSpeed : walkSpeed);
      return {
        key: resolved,
        timeScale: THREE.MathUtils.clamp(speed / natural, cfg.minTimeScale, cfg.maxTimeScale),
      };
    }

    if (input.aiming) return { key: resolve(fireTimer > 0 ? 'fire' : 'aim') ?? 'idle', timeScale: 1 };
    return { key: 'idle', timeScale: 1 };
  }

  /** What the UPPER BODY does: the legs' clip, unless the hands are busy. */
  function chooseUpper(input: AnimationInput, legs: Pick, speed: number): Pick {
    if (input.dead) return legs;
    // Reloading: the hands work the magazine whatever the legs are doing — on
    // the run, crouched behind a crate, or standing.
    if (input.reloading && lower.actions.has('reload')) return { key: 'reload', timeScale: 1 };
    // Firing on the move: the shooting arms over walking / strafing legs, and
    // the dedicated run-and-gun clip when running.
    if (fireTimer > 0 && speed > cfg.moveThreshold && !input.crouching) {
      if (legs.key === 'run') return { key: resolve('runFire') ?? 'run', timeScale: legs.timeScale };
      return { key: resolve('fire') ?? legs.key, timeScale: 1 };
    }
    // Aiming while moving: hold the rifle up rather than swinging it.
    if (input.aiming && speed > cfg.moveThreshold && !input.crouching && legs.key !== 'run') {
      return { key: resolve('aim') ?? legs.key, timeScale: 1 };
    }
    return legs;
  }

  function apply(input: AnimationInput) {
    const speed = Math.hypot(input.velocity.x, input.velocity.z);
    const legs = chooseLegs(input, speed);
    const arms = chooseUpper(input, legs, speed);

    const fade =
      legs.key === 'death' ? cfg.deathFade : legs.key === 'aim' || legs.key === 'fire' || legs.key === 'crouch' ? cfg.aimFade : cfg.fade;
    lower.play(legs.key, fade, legs.timeScale);

    // When the upper body rejoins the legs' clip, it starts in step with them.
    const sameClip = arms.key === legs.key;
    const armFade = arms.key === 'reload' ? cfg.fade : cfg.aimFade;
    upper.play(arms.key, sameClip ? fade : armFade, arms.timeScale, sameClip && upper.current !== arms.key ? lower.action?.time : undefined);
  }

  return {
    get current() {
      return lower.current;
    },
    get upperCurrent() {
      return upper.current;
    },
    get reloadDuration() {
      return set.clips.reload?.duration;
    },

    update(dt, input) {
      fireTimer = Math.max(0, fireTimer - dt);

      apply(input);
      mixer.update(dt);

      // ---- procedural layers, applied on top of the sampled pose ----
      // World matrices must be current before converting world axes to bone
      // space, and again afterwards so hit proxies on the spine follow.
      root.updateMatrixWorld(true);

      right.set(Math.cos(input.yaw), 0, -Math.sin(input.yaw));

      const wantPitch =
        input.aiming && !input.dead && !input.reloading
          ? THREE.MathUtils.clamp(input.aimPitch, -cfg.maxAimPitch, cfg.maxAimPitch)
          : 0;
      pitch += (wantPitch - pitch) * Math.min(1, dt * 10);

      // Spring: x'' = -k x - c x'
      const k = 180;
      const c = 2 * Math.sqrt(k) * 0.55;
      flinchVel += (-k * flinchAngle - c * flinchVel) * dt;
      flinchAngle += flinchVel * dt;
      flinchTwist *= Math.exp(-dt * 9);

      if (!input.dead) {
        // Split across two vertebrae, as a real spine bends.
        const lean = pitch + flinchAngle;
        if (spineLower) rotateBoneWorld(spineLower, right, lean * 0.4);
        if (spineUpper && spineUpper !== spineLower) rotateBoneWorld(spineUpper, right, lean * 0.6);
        if (spineUpper) rotateBoneWorld(spineUpper, _axis.copy(up), flinchTwist);
        root.updateMatrixWorld(true);
      }
    },

    fired() {
      fireTimer = cfg.fireHold;
    },

    flinch(strength = 1) {
      // Positive pitch about the character's right axis leans the chest back.
      flinchVel += cfg.flinchKick * THREE.MathUtils.clamp(strength, 0.2, 1);
      flinchTwist += (Math.random() - 0.5) * 0.35 * strength;
    },

    reset() {
      mixer.stopAllAction();
      lower.reset();
      upper.reset();
      fireTimer = 0;
      pitch = 0;
      flinchAngle = 0;
      flinchVel = 0;
      flinchTwist = 0;
      lower.play('idle', 0, 1);
      upper.play('idle', 0, 1, 0);
    },

    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
    },
  };
}
