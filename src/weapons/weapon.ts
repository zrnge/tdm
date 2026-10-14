/**
 * Weapon instances: fire rate, magazine, reload, spread growth and recoil.
 *
 * Pure state — it owns no meshes and no scene objects. It answers one question
 * per frame ("did a shot leave the barrel?") and one per shot ("where was it
 * aimed?"), and leaves the consequences to `src/combat/combat.ts`. That split
 * is what lets the same weapon drive the player, a bot, and the first-person
 * viewmodel without duplication.
 */
import * as THREE from 'three';
import { VIEWMODEL, WEAPONS, type WeaponId } from '../config';

export interface WeaponDefinition {
  id: WeaponId;
  name: string;
  damage: number;
  rpm: number;
  magazine: number;
  reloadTime: number;
  range: number;
  automatic: boolean;
  spread: {
    base: number;
    ads: number;
    crouchScale: number;
    movePerSpeed: number;
    perShot: number;
    max: number;
    recover: number;
  };
  recoil: {
    vertical: number;
    horizontal: number;
    recover: number;
    maxVertical: number;
  };
}

/** What the shooter is doing, which is all the spread model needs to know. */
export interface AimContext {
  /** Horizontal speed, m/s. */
  speed: number;
  crouching: boolean;
  aiming: boolean;
}

export interface Weapon {
  readonly id: WeaponId;
  readonly def: WeaponDefinition;
  /** Rounds left in the magazine. */
  readonly ammo: number;
  readonly reloading: boolean;
  /** 0..1 through the reload. */
  readonly reloadProgress: number;
  /** True once the new magazine is seated and the rounds are back. */
  readonly reloadRefilled: boolean;
  /** Current spread half-angle, degrees. Drives the reactive crosshair. */
  readonly spread: number;
  /** Accumulated recoil in degrees, for the camera kick. */
  readonly recoil: { vertical: number; horizontal: number };
  /** True when the magazine is empty and a reload is required. */
  readonly empty: boolean;
  /** True when a shot can be fired right now. */
  canFire(): boolean;
  /**
   * Fires one round if possible. Returns the aim direction in world space, or
   * null when the trigger pull produced no shot (cooling down, empty, reloading).
   *
   * The spread cone is already tracked in `spread` by `update()`, so this needs
   * no stance context — which keeps the fire path allocation-free.
   */
  tryFire(origin: THREE.Vector3, forward: THREE.Vector3): THREE.Vector3 | null;
  /**
   * Begins a reload if it makes sense. Returns true when one started.
   *
   * `animationDuration` is the length of the reload CLIP, in seconds, when the
   * viewmodel has one. It overrides `def.reloadTime`, because the two reload
   * clips are different lengths and squeezing the long one into the short one's
   * time is very visible.
   */
  startReload(animationDuration?: number): boolean;
  /**
   * Cancels a reload in progress.
   *
   * Called ONLY on death and on a weapon switch. Firing, sprinting and pressing
   * R again must all leave a reload alone: a reload that can be interrupted by
   * the trigger is a reload the player cannot trust, and re-pressing R is how
   * players ask "is it reloading?".
   */
  cancelReload(): void;
  /** Advances timers. Call once per frame. */
  update(dt: number, ctx: AimContext): void;
  /** Restores a full magazine, for respawn. */
  refill(): void;
  /** Clears accumulated recoil, for respawn. */
  reset(): void;
}

export function createWeapon(id: WeaponId): Weapon {
  const def = WEAPONS[id] as WeaponDefinition;

  let ammo: number = def.magazine;
  let cooldown = 0;
  let reloadRemaining = 0;
  let reloadTotal = 0;
  let reloadRefilled = false;
  /** Fraction of the reload at which the magazine is seated. */
  let refillAt = 0.7;
  let spread = def.spread.base;
  const recoil = { vertical: 0, horizontal: 0 };

  const shotInterval = 60 / def.rpm;

  function canFire(): boolean {
    return cooldown <= 0 && reloadRemaining <= 0 && ammo > 0;
  }

  function tryFire(origin: THREE.Vector3, forward: THREE.Vector3): THREE.Vector3 | null {
    if (!canFire()) {
      // An empty magazine auto-reloads on the trigger pull, which is what every
      // shooter does and what players expect.
      if (ammo <= 0 && reloadRemaining <= 0) startReload();
      return null;
    }

    ammo--;
    cooldown = shotInterval;

    // ---- aim direction: forward, displaced inside the spread cone ----
    const dir = forward.clone();
    if (spread > 1e-4) {
      // A random point in the unit disc, scaled to the cone half-angle.
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * THREE.MathUtils.degToRad(spread);
      const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      const up = new THREE.Vector3().crossVectors(right, dir).normalize();
      dir
        .addScaledVector(right, Math.tan(radius) * Math.cos(angle))
        .addScaledVector(up, Math.tan(radius) * Math.sin(angle))
        .normalize();
    }

    // ---- spread grows with each shot ----
    spread = Math.min(spread + def.spread.perShot, def.spread.max);

    // ---- recoil kicks up and sideways ----
    recoil.vertical = Math.min(recoil.vertical + def.recoil.vertical, def.recoil.maxVertical);
    recoil.horizontal += (Math.random() * 2 - 1) * def.recoil.horizontal;

    void origin;
    return dir;
  }

  function startReload(animationDuration?: number): boolean {
    // A reload already in progress is left alone. Re-pressing R is how players
    // ask "is it reloading?", not a request to restart it.
    if (reloadRemaining > 0 || ammo >= def.magazine) return false;
    const duration =
      animationDuration && animationDuration > 1e-3 ? animationDuration : def.reloadTime;
    reloadTotal = duration;
    reloadRemaining = duration;
    // An empty reload has to strip the old magazine and rack the bolt, so the
    // fresh magazine is seated later in the clip than in a tactical one.
    refillAt = ammo <= 0 ? VIEWMODEL.reload.refillAtEmpty : VIEWMODEL.reload.refillAtTactical;
    reloadRefilled = false;
    return true;
  }

  function update(dt: number, ctx: AimContext) {
    if (cooldown > 0) cooldown = Math.max(0, cooldown - dt);

    if (reloadRemaining > 0) {
      reloadRemaining -= dt;
      // The rounds come back when the magazine is seated, not at the end of the
      // clip: the last part of a reload animation is the charging handle and the
      // weapon coming back up, and refilling at the end makes the HUD counter
      // disagree with what the animation is showing.
      if (!reloadRefilled && 1 - reloadRemaining / reloadTotal >= refillAt) {
        reloadRefilled = true;
        ammo = def.magazine;
      }
      if (reloadRemaining <= 0) {
        reloadRemaining = 0;
        // Safety net: a reload that somehow never crossed `refillAt` still ends
        // with a full magazine.
        if (!reloadRefilled) {
          reloadRefilled = true;
          ammo = def.magazine;
        }
      }
    }

    // ---- spread target for the current stance ----
    let target = ctx.aiming ? def.spread.ads : def.spread.base;
    if (ctx.crouching) target *= def.spread.crouchScale;
    target += ctx.speed * def.spread.movePerSpeed;

    // Spread decays toward the target; the shot penalty decays faster than the
    // stance target, so tapping is accurate and spraying is not.
    const decay = def.spread.recover * dt;
    if (spread > target) {
      spread = Math.max(target, spread - decay);
    } else {
      spread = Math.min(target, spread + decay);
    }

    // ---- recoil recovery ----
    const rDecay = def.recoil.recover * dt;
    recoil.vertical = Math.max(0, recoil.vertical - rDecay);
    recoil.horizontal = approach(recoil.horizontal, 0, rDecay);
  }

  return {
    get id() {
      return def.id;
    },
    get def() {
      return def;
    },
    get ammo() {
      return ammo;
    },
    get reloading() {
      return reloadRemaining > 0;
    },
    get reloadProgress() {
      return reloadTotal > 0 ? 1 - reloadRemaining / reloadTotal : 0;
    },
    get reloadRefilled() {
      return reloadRefilled;
    },
    get spread() {
      return spread;
    },
    get recoil() {
      return recoil;
    },
    get empty() {
      return ammo <= 0;
    },
    canFire,
    tryFire,
    startReload,
    cancelReload() {
      reloadRemaining = 0;
      reloadTotal = 0;
      reloadRefilled = false;
    },
    update,
    refill() {
      ammo = def.magazine;
      reloadRemaining = 0;
      reloadTotal = 0;
      reloadRefilled = false;
    },
    reset() {
      cooldown = 0;
      reloadRemaining = 0;
      reloadTotal = 0;
      reloadRefilled = false;
      spread = def.spread.base;
      recoil.vertical = 0;
      recoil.horizontal = 0;
    },
  };
}

const UP = new THREE.Vector3(0, 1, 0);

function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}
