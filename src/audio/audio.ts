/**
 * Sound.
 *
 * Gameplay sounds play RECORDED samples from `public/audio/` (see
 * `samples.ts`): rifle shots and reload parts, concrete footsteps, bullet
 * impacts per surface, body falls and the player being hit. Every sound also
 * has a SYNTHESISED fallback built from Web Audio primitives (filtered noise
 * bursts, pitched sine sweeps), used until its samples have decoded or if a
 * file is missing. UI tones (hit markers, heartbeat), the bullet whiz and the
 * room tone are synthesis only.
 *
 * Samples go through exactly the same routing as the synthesis, so a recorded
 * shot from an enemy is positioned, distance-filtered and reverberated like any
 * other sound.
 *
 * ## Signal chain
 *
 *     voice -> [panner] -> distance lowpass -> dry bus ----------> master -> limiter -> out
 *                                           \-> reverb send -> warehouse IR -/
 *
 * - **Positional sounds** go through an `HRTF` panner, so a shot from behind and
 *   to the left sounds like it. The listener is the world camera, updated every
 *   frame.
 * - **Distance** does three things, as it does in a real building: the sound
 *   gets quieter (the panner's inverse rolloff), duller (a lowpass that closes
 *   with distance — air and walls eat the highs), and wetter (more of it reaches
 *   you as reverb than as direct sound).
 * - **The warehouse** is a generated impulse response: ~1 s of fast-decaying
 *   stereo noise. Deliberately short and low in the mix: a longer tail stacked
 *   on recorded samples sounded like an echo, not a room.
 * - **The limiter** keeps a full 4v4 firefight from clipping.
 *
 * The AudioContext cannot start until the user interacts with the page, so
 * `resume()` is called from the "click to play" button. Every method is a safe
 * no-op until then.
 */
import * as THREE from 'three';
import { AUDIO } from '../config';
import { loadSamples, SAMPLE_LEAD, type SampleBank, type SampleKey } from './samples';

export type Surface = 'metal' | 'concrete' | 'wood' | 'flesh';

/**
 * When the parts of a reload happen, as FRACTIONS of its duration. The player's
 * timings are measured from the viewmodel's own weapon bones (see
 * VIEWMODEL.reload.events); bots use a generic rifle reload.
 */
export interface ReloadTiming {
  release: number;
  magOut: number;
  magIn: number;
  boltBack?: number;
  boltForward?: number;
}

const GENERIC_RELOAD: ReloadTiming = { release: 0.12, magOut: 0.18, magIn: 0.6, boltBack: 0.8, boltForward: 0.86 };

export interface AudioSystem {
  /**
   * Starts the context. Must be called from a user gesture. The system also
   * listens for ANY click or key press and resumes itself, so a context the
   * browser suspended (tab switch, page reload, focus loss) comes back on the
   * player's next input instead of staying silent.
   */
  resume(): void;
  /** Master volume, 0..~1. */
  setVolume(gain: number): void;
  /** A gunshot and a confirmation tone, for the settings panel's TEST button. */
  test(): void;
  /** Puts the listener at the camera. Call once per frame. */
  updateListener(camera: THREE.Camera): void;
  /** A rifle shot. `at` null means the player's own gun. */
  gunshot(at: THREE.Vector3 | null): void;
  /** A footstep. `intensity` is 0..1 (creep .. sprint). `at` null is the player. */
  footstep(at: THREE.Vector3 | null, intensity: number): void;
  /** The full reload sequence over `duration` seconds, at the given timing. */
  reload(at: THREE.Vector3 | null, duration: number, empty: boolean, timing?: ReloadTiming): void;
  /** A bullet striking a surface. */
  impact(at: THREE.Vector3, surface: Surface): void;
  /** A round passing close to the listener's head. */
  whiz(at: THREE.Vector3): void;
  /** Confirmation tick when the player's shot lands. */
  hitmarker(headshot: boolean, kill: boolean): void;
  /** The player was hit. */
  hurt(amount: number): void;
  /** A body hitting the floor. */
  bodyfall(at: THREE.Vector3): void;
  /** Low-health heartbeat; 0 disables it. Call every frame. */
  setHeartbeat(urgency: number, dt: number): void;
  readonly ready: boolean;
}

export function createAudio(): AudioSystem {
  let ctx: AudioContext | null = null;
  let master: GainNode;
  let dry: GainNode;
  let reverbSend: GainNode;
  let noise: AudioBuffer;
  let samples: SampleBank | null = null;
  const listenerPos = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  let heartbeatTimer = 0;
  let volume: number = AUDIO.master;

  function init() {
    ctx = new AudioContext();
    ctx.addEventListener('statechange', () => console.log(`[audio] ${ctx!.state}`));
    console.log(`[audio] context created (${ctx.state}, ${ctx.sampleRate} Hz)`);

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    limiter.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(limiter);

    dry = ctx.createGain();
    dry.connect(master);

    const convolver = ctx.createConvolver();
    convolver.buffer = warehouseImpulse(ctx);
    const wet = ctx.createGain();
    // Kept low: a recorded sample already carries some room, and stacking a
    // long wet tail on top of it read as an echo rather than a building.
    wet.gain.value = 0.22;
    convolver.connect(wet).connect(master);
    reverbSend = ctx.createGain();
    reverbSend.connect(convolver);

    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    startRoomTone();
    samples = loadSamples(ctx);
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  /**
   * A per-sound output: positional (panned, distance-filtered) or, for the
   * player's own sounds, centred. Returns the node voices connect into.
   */
  function output(at: THREE.Vector3 | null, gain: number, reverb: number): AudioNode {
    const c = ctx!;
    const t = c.currentTime;
    const out = c.createGain();
    out.gain.value = gain;

    if (!at) {
      out.connect(dry);
      const send = c.createGain();
      send.gain.value = reverb;
      out.connect(send).connect(reverbSend);
      return out;
    }

    const distance = at.distanceTo(listenerPos);
    const panner = c.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = AUDIO.refDistance;
    panner.maxDistance = AUDIO.maxDistance;
    panner.rolloffFactor = 1.1;
    panner.positionX.setValueAtTime(at.x, t);
    panner.positionY.setValueAtTime(at.y, t);
    panner.positionZ.setValueAtTime(at.z, t);

    // Air and obstacles absorb highs first.
    const lowpass = c.createBiquadFilter();
    lowpass.type = 'lowpass';
    const k = THREE.MathUtils.clamp(distance / 45, 0, 1);
    lowpass.frequency.value = THREE.MathUtils.lerp(18000, 1400, Math.sqrt(k));

    out.connect(panner).connect(lowpass).connect(dry);
    // Far sounds arrive mostly as reverb.
    const send = c.createGain();
    send.gain.value = reverb * THREE.MathUtils.lerp(0.5, 1.2, k) * Math.min(1, 6 / Math.max(distance, 1) + 0.25);
    out.connect(send).connect(reverbSend);
    return out;
  }

  /** Filtered noise burst with an exponential decay. */
  function noiseBurst(
    dest: AudioNode,
    when: number,
    opts: { type: BiquadFilterType; freq: number; q?: number; gain: number; attack?: number; decay: number; sweepTo?: number }
  ) {
    const c = ctx!;
    const src = c.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const filter = c.createBiquadFilter();
    filter.type = opts.type;
    filter.frequency.setValueAtTime(opts.freq, when);
    if (opts.sweepTo) filter.frequency.exponentialRampToValueAtTime(opts.sweepTo, when + opts.decay);
    filter.Q.value = opts.q ?? 0.8;
    const env = c.createGain();
    const attack = opts.attack ?? 0.001;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(opts.gain, when + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, when + attack + opts.decay);
    src.connect(filter).connect(env).connect(dest);
    src.start(when, Math.random() * 1.5, attack + opts.decay + 0.05);
  }

  /** Sine (or other) tone with a pitch sweep and exponential decay. */
  function tone(
    dest: AudioNode,
    when: number,
    opts: { freq: number; to?: number; gain: number; decay: number; type?: OscillatorType; attack?: number }
  ) {
    const c = ctx!;
    const osc = c.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, when);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, when + opts.decay);
    const env = c.createGain();
    const attack = opts.attack ?? 0.002;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(opts.gain, when + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, when + attack + opts.decay);
    osc.connect(env).connect(dest);
    osc.start(when);
    osc.stop(when + attack + opts.decay + 0.05);
  }

  /**
   * Plays a random take of `key` into `dest` so its transient lands at `when`.
   * Returns false when no take has loaded yet, so the caller can synthesise.
   */
  function sample(dest: AudioNode, key: SampleKey, when: number, gain = 1, pitchVary = 0.04): boolean {
    const buffer = samples?.pick(key);
    if (!buffer) return false;
    const c = ctx!;
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = vary(pitchVary);
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    src.start(Math.max(c.currentTime, when - (SAMPLE_LEAD[key] ?? 0)));
    return true;
  }

  /** A small metallic click: the building block of every weapon mechanism. */
  function click(dest: AudioNode, when: number, gain: number, pitch = 1) {
    noiseBurst(dest, when, { type: 'bandpass', freq: 3800 * pitch, q: 2.5, gain, decay: 0.025 });
    tone(dest, when, { freq: 1700 * pitch, to: 1500 * pitch, gain: gain * 0.35, decay: 0.04, type: 'triangle' });
  }

  // ---------------------------------------------------------------------------
  // Ambience
  // ---------------------------------------------------------------------------

  /** Very quiet room tone: low rumble plus the 120 Hz hum of the strip lights. */
  function startRoomTone() {
    const c = ctx!;
    const rumble = c.createBufferSource();
    rumble.buffer = noise;
    rumble.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    const rg = c.createGain();
    // Felt, not heard: louder than this reads as hiss under every sound.
    rg.gain.value = 0.012;
    rumble.connect(lp).connect(rg).connect(dry);
    rumble.start();

    for (const [f, g] of [
      [120, 0.006],
      [240, 0.003],
      [360, 0.0015],
    ] as const) {
      const osc = c.createOscillator();
      osc.frequency.value = f;
      const og = c.createGain();
      og.gain.value = g;
      osc.connect(og).connect(dry);
      osc.start();
    }
  }

  const ok = () => !!ctx && ctx.state === 'running';
  const vary = (amount: number) => 1 + (Math.random() - 0.5) * 2 * amount;

  function resume() {
    if (!ctx) init();
    if (ctx!.state !== 'running') void ctx!.resume();
  }

  // Any input unlocks/resumes audio, not just the play button.
  for (const type of ['pointerdown', 'keydown', 'click'] as const) {
    window.addEventListener(type, resume, { capture: true });
  }

  const api: AudioSystem = {
    get ready() {
      return ok();
    },

    resume,

    setVolume(gain) {
      volume = gain;
      if (ctx) master.gain.setTargetAtTime(gain, ctx.currentTime, 0.02);
    },

    test() {
      resume();
      // The context may need a moment to start after the click that resumed it.
      setTimeout(() => {
        api.gunshot(null);
        if (!ok()) return;
        const out = output(null, 0.4, 0);
        tone(out, ctx!.currentTime + 0.35, { freq: 880, gain: 0.5, decay: 0.15, type: 'triangle' });
      }, 60);
    },

    updateListener(camera) {
      camera.getWorldPosition(listenerPos);
      if (!ctx) return;
      const l = ctx.listener;
      camera.getWorldDirection(fwd);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      const t = ctx.currentTime;
      if (l.positionX) {
        l.positionX.setValueAtTime(listenerPos.x, t);
        l.positionY.setValueAtTime(listenerPos.y, t);
        l.positionZ.setValueAtTime(listenerPos.z, t);
        l.forwardX.setValueAtTime(fwd.x, t);
        l.forwardY.setValueAtTime(fwd.y, t);
        l.forwardZ.setValueAtTime(fwd.z, t);
        l.upX.setValueAtTime(up.x, t);
        l.upY.setValueAtTime(up.y, t);
        l.upZ.setValueAtTime(up.z, t);
      } else {
        l.setPosition(listenerPos.x, listenerPos.y, listenerPos.z);
        l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
      }
    },

    gunshot(at) {
      if (!ok()) return;
      const c = ctx!;
      const t = c.currentTime;
      const own = !at;
      const out = output(at, own ? 0.9 : 1.4, own ? 0.2 : 0.35);
      if (sample(out, 'gunshot', t, own ? 0.9 : 1.0, 0.03)) {
        // The recording has no sub-bass and nothing above ~12 kHz. A real
        // rifle has both: the muzzle blast you feel in the chest, and the
        // supersonic crack. Both are layered under the sample, short and dry.
        const v = vary(0.04);
        tone(out, t, { freq: 120 * v, to: 38, gain: own ? 0.9 : 0.6, decay: 0.12 });
        noiseBurst(out, t, { type: 'highpass', freq: 5000 * v, gain: own ? 0.5 : 0.25, decay: 0.035 });
        // Your own rifle: the bolt cycling, which you only hear up close.
        if (own) click(out, t + 0.035, 0.12, vary(0.05));
        return;
      }
      const v = vary(0.06);
      // Supersonic crack: broadband, very fast.
      noiseBurst(out, t, { type: 'highpass', freq: 1200 * v, gain: 1.0, decay: 0.07 });
      noiseBurst(out, t, { type: 'bandpass', freq: 2600 * v, q: 0.6, gain: 0.8, decay: 0.11 });
      // Muzzle blast: the chest-thump body of the shot.
      tone(out, t, { freq: 150 * v, to: 42, gain: 1.0, decay: 0.16 });
      noiseBurst(out, t, { type: 'lowpass', freq: 900 * v, gain: 0.9, decay: 0.22, sweepTo: 200 });
      // The shed answering back: a dull low tail under the convolver reverb.
      noiseBurst(out, t + 0.02, { type: 'lowpass', freq: 500, gain: 0.25, attack: 0.03, decay: 0.55, sweepTo: 120 });
      // Your own rifle: the bolt cycling, which you only hear up close.
      if (own) click(out, t + 0.035, 0.18, vary(0.05));
    },

    footstep(at, intensity) {
      if (!ok()) return;
      const t = ctx!.currentTime;
      const i = THREE.MathUtils.clamp(intensity, 0.15, 1);
      const out = output(at, (at ? 0.75 : 0.32) * i, 0.06);
      if (sample(out, 'footstepConcrete', t, 1.1, 0.08)) {
        // Kit rattle when running.
        if (i > 0.7) click(out, t + 0.04 + Math.random() * 0.03, 0.05 * i, 0.8);
        return;
      }
      const v = vary(0.12);
      // Boot on concrete: a soft heel thud then the sole's scuff.
      tone(out, t, { freq: 95 * v, to: 55, gain: 0.7, decay: 0.05 });
      noiseBurst(out, t, { type: 'bandpass', freq: 900 * v, q: 1.1, gain: 0.55, decay: 0.045 });
      noiseBurst(out, t + 0.025, { type: 'highpass', freq: 3000 * v, gain: 0.18 * i, decay: 0.06 });
      // Kit rattle when running.
      if (i > 0.7) click(out, t + 0.04 + Math.random() * 0.03, 0.05 * i, 0.8 * v);
    },

    reload(at, duration, empty, timing = GENERIC_RELOAD) {
      if (!ok()) return;
      const t = ctx!.currentTime;
      const out = output(at, at ? 0.8 : 0.55, 0.05);
      const d = Math.max(duration, 0.6);
      const when = (f: number) => t + d * f;
      // Release lever, then the old magazine scraping out of the well.
      click(out, when(timing.release), 0.35, 0.9);
      // Recorded parts, each on its measured beat of the animation.
      const boltBeats = empty && timing.boltBack !== undefined && timing.boltForward !== undefined;
      if (sample(out, 'reloadMagOut', when(timing.magOut), 0.8, 0.03)) {
        sample(out, 'reloadMagIn', when(timing.magIn), 1.0, 0.03);
        if (boltBeats) {
          sample(out, 'reloadBoltBack', when(timing.boltBack!), 0.9, 0.03);
          sample(out, 'reloadBoltForward', when(timing.boltForward!), 1.0, 0.03);
        }
        return;
      }
      noiseBurst(out, when(timing.magOut), { type: 'bandpass', freq: 1400, q: 1.5, gain: 0.25, attack: 0.02, decay: 0.12, sweepTo: 2600 });
      // The new magazine sliding in, then seating with a clack.
      noiseBurst(out, when(timing.magIn) - 0.09, { type: 'bandpass', freq: 2200, q: 1.2, gain: 0.2, attack: 0.03, decay: 0.08, sweepTo: 1200 });
      click(out, when(timing.magIn), 0.55, 0.75);
      click(out, when(timing.magIn) + 0.03, 0.35, 1.1);
      tone(out, when(timing.magIn), { freq: 210, to: 120, gain: 0.35, decay: 0.06 });
      if (empty && timing.boltBack !== undefined && timing.boltForward !== undefined) {
        // Bolt pulled back, then slammed forward.
        noiseBurst(out, when(timing.boltBack), { type: 'bandpass', freq: 1800, q: 2, gain: 0.3, decay: 0.07, sweepTo: 3200 });
        click(out, when(timing.boltBack), 0.3, 1.2);
        click(out, when(timing.boltForward), 0.6, 0.95);
        tone(out, when(timing.boltForward), { freq: 260, to: 140, gain: 0.3, decay: 0.05 });
      }
    },

    impact(at, surface) {
      if (!ok()) return;
      const t = ctx!.currentTime;
      const out = output(at, 0.7, 0.12);
      const key: SampleKey =
        surface === 'flesh'
          ? 'impactFlesh'
          : surface === 'metal'
            ? 'impactMetal'
            : surface === 'wood'
              ? 'impactWood'
              : 'impactConcrete';
      if (sample(out, key, t, 0.9, 0.12)) {
        // The occasional ricochet whine off a hard surface.
        if (surface !== 'flesh' && Math.random() < 0.18) {
          const from = 2400 + Math.random() * 1600;
          tone(out, t + 0.01, { freq: from, to: from * 0.55, gain: 0.12, decay: 0.3, type: 'sine', attack: 0.01 });
        }
        return;
      }
      const v = vary(0.15);
      if (surface === 'flesh') {
        tone(out, t, { freq: 110 * v, to: 60, gain: 0.6, decay: 0.07 });
        noiseBurst(out, t, { type: 'lowpass', freq: 700 * v, gain: 0.5, decay: 0.06 });
        return;
      }
      if (surface === 'metal') {
        // A struck steel panel rings at a few inharmonic partials.
        noiseBurst(out, t, { type: 'highpass', freq: 2500, gain: 0.5, decay: 0.03 });
        for (const [f, g] of [
          [870, 0.25],
          [1430, 0.18],
          [2310, 0.12],
        ] as const) {
          tone(out, t, { freq: f * v, gain: g, decay: 0.35 + Math.random() * 0.2, type: 'triangle' });
        }
      } else {
        // Concrete / wood: a dry chip of debris.
        noiseBurst(out, t, { type: 'bandpass', freq: (surface === 'wood' ? 1100 : 1900) * v, q: 0.9, gain: 0.7, decay: 0.05 });
        tone(out, t, { freq: 160 * v, to: 80, gain: 0.25, decay: 0.04 });
      }
      // The occasional ricochet whine.
      if (Math.random() < 0.18) {
        const from = 2400 + Math.random() * 1600;
        tone(out, t + 0.01, { freq: from, to: from * 0.55, gain: 0.12, decay: 0.3, type: 'sine', attack: 0.01 });
      }
    },

    whiz(at) {
      if (!ok()) return;
      const t = ctx!.currentTime;
      // Close, so barely any distance filtering: a sharp snap and a quick hiss.
      const out = output(at, 0.9, 0.1);
      noiseBurst(out, t, { type: 'highpass', freq: 3500, gain: 0.6, decay: 0.03 });
      noiseBurst(out, t, { type: 'bandpass', freq: 4200, q: 1.2, gain: 0.5, attack: 0.02, decay: 0.12, sweepTo: 1500 });
    },

    hitmarker(headshot, kill) {
      if (!ok()) return;
      const t = ctx!.currentTime;
      const out = output(null, 0.35, 0);
      if (kill) {
        tone(out, t, { freq: 1050, gain: 0.5, decay: 0.08, type: 'triangle' });
        tone(out, t + 0.07, { freq: 1400, gain: 0.45, decay: 0.14, type: 'triangle' });
      } else if (headshot) {
        tone(out, t, { freq: 1900, gain: 0.45, decay: 0.18, type: 'triangle' });
        tone(out, t, { freq: 3800, gain: 0.15, decay: 0.12 });
      } else {
        noiseBurst(out, t, { type: 'bandpass', freq: 3000, q: 3, gain: 0.5, decay: 0.02 });
        tone(out, t, { freq: 2200, gain: 0.25, decay: 0.03, type: 'triangle' });
      }
    },

    hurt(amount) {
      if (!ok()) return;
      const t = ctx!.currentTime;
      const g = THREE.MathUtils.clamp(amount / 40, 0.3, 1);
      const out = output(null, 0.8 * g, 0.05);
      // The low thump is kept under the recording: it is what makes a hit felt.
      tone(out, t, { freq: 80, to: 40, gain: 0.6, decay: 0.22 });
      if (sample(out, 'hurt', t, 0.9, 0.08)) return;
      noiseBurst(out, t, { type: 'lowpass', freq: 400, gain: 0.6, decay: 0.15 });
    },

    bodyfall(at) {
      if (!ok()) return;
      const t = ctx!.currentTime;
      const out = output(at, 0.8, 0.1);
      // The body hits the floor, then the gear settles a beat later.
      if (sample(out, 'bodyfall', t + 0.45, 1.0, 0.06)) {
        sample(out, 'bodyfall', t + 0.75, 0.45, 0.1);
        return;
      }
      tone(out, t + 0.45, { freq: 90, to: 45, gain: 0.7, decay: 0.15 });
      noiseBurst(out, t + 0.45, { type: 'lowpass', freq: 600, gain: 0.5, decay: 0.12 });
      click(out, t + 0.5, 0.2, 0.7);
      tone(out, t + 0.75, { freq: 70, to: 40, gain: 0.4, decay: 0.12 });
    },

    setHeartbeat(urgency, dt) {
      if (!ok() || urgency <= 0) {
        heartbeatTimer = 0;
        return;
      }
      heartbeatTimer -= dt;
      if (heartbeatTimer > 0) return;
      const interval = THREE.MathUtils.lerp(1.05, 0.6, urgency);
      heartbeatTimer = interval;
      const t = ctx!.currentTime;
      const out = output(null, 0.5 * urgency, 0);
      tone(out, t, { freq: 58, to: 40, gain: 0.9, decay: 0.12 });
      tone(out, t + 0.22, { freq: 52, to: 38, gain: 0.6, decay: 0.12 });
    },
  };
  return api;
}

/** A generated impulse response for a large, hard-walled steel warehouse. */
function warehouseImpulse(ctx: AudioContext): AudioBuffer {
  const seconds = 1.1;
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / ctx.sampleRate;
      // Early reflections off the near walls, then a smooth exponential tail.
      const early = t < 0.08 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 0.9 : 0;
      const tail = (Math.random() * 2 - 1) * Math.exp(-t * 6.5) * (t < 0.012 ? t / 0.012 : 1);
      data[i] = early + tail * 0.55;
    }
  }
  return buffer;
}
