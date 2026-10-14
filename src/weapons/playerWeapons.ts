/**
 * The player's weapon handling: input, aim point, recoil kick, ADS, reload.
 *
 * This is the glue between `input.ts` (what the player pressed), `weapon.ts`
 * (what the gun can do), `combat.ts` (what the shot hits) and `effects.ts`
 * (what it looks like). It owns no state that belongs to any of them.
 *
 * ## Where the shot comes from and where it goes
 *
 * The player is first-person, so the muzzle is the VIEWMODEL's muzzle — the real
 * end of the gun mesh the player can see — transformed into world space through
 * the viewmodel camera. The aim point is a point far down the world camera's
 * centre ray, so the crosshair is honest. `combat.fire()` then reconciles the
 * two: the muzzle ray must be clear, and the camera ray decides what was hit.
 *
 * ## Why the muzzle is not the camera
 *
 * A camera-only ray would let the player fire through a wall they are standing
 * flush against. A muzzle-only ray would not point where the crosshair points.
 * Doing both is what gives "you cannot shoot through cover" without the
 * crosshair lying.
 *
 * ## Reload
 *
 * The reload's DURATION comes from the animation clip, not from a number in
 * config: RELOAD1 and RELOAD2 are different lengths and squeezing the long one
 * into the short one's time is very visible. The weapon's own timer is started
 * with the clip's duration and the rounds come back at the point the magazine is
 * seated, which `weapon.ts` handles.
 *
 * A reload plays to completion. Firing, sprinting and re-pressing R all leave it
 * alone — only death and a weapon switch cancel it. Aiming is blocked for the
 * duration, because the arms are busy and the sights are nowhere near the eye.
 */
import * as THREE from 'three';
import { CAMERA, WEAPON_ORDER, type WeaponId } from '../config';
import type { InputState } from '../core/input';
import type { Player } from '../player/player';
import type { Combat, Combatant } from '../combat/combat';
import type { Effects } from '../combat/effects';
import { createWeapon, type AimContext, type Weapon } from './weapon';
import type { Viewmodel } from './viewmodel';

export interface PlayerWeapons {
  readonly current: Weapon;
  /** All weapons the player carries, in slot order. */
  readonly slots: Weapon[];
  /** Aim-down-sights state, smoothed 0..1 for the camera and HUD. */
  readonly adsAmount: number;
  /** Recoil pitch the camera should add this frame, radians. */
  readonly recoilPitch: number;
  /** Recoil yaw the camera should add this frame, radians. */
  readonly recoilYaw: number;
  /** True while the player is holding the aim button AND able to aim. */
  readonly aiming: boolean;
  /** True while the current weapon is reloading. */
  readonly reloading: boolean;
  update(dt: number): void;
  /** Called on respawn: refill and play the draw animation. */
  respawn(): void;
}

export interface PlayerWeaponsOptions {
  input: InputState;
  player: Player;
  combat: Combat;
  effects: Effects;
  /** The world camera. Its centre ray is the player's aim. */
  camera: THREE.PerspectiveCamera;
  /** The combatant record for the player, for damage attribution. */
  self: Combatant;
  viewmodel: Viewmodel | null;
  /** Called when the player fires, so the HUD and audio can react. */
  onShot?(weapon: Weapon, hit: ReturnType<Combat['fire']>): void;
  /** Called when a reload starts, with its duration and whether it is from empty. */
  onReload?(weapon: Weapon, duration: number, empty: boolean): void;
}

export function createPlayerWeapons(opts: PlayerWeaponsOptions): PlayerWeapons {
  const { input, player, combat, effects, camera, self, viewmodel } = opts;

  const slots: Weapon[] = WEAPON_ORDER.map((id: WeaponId) => createWeapon(id));
  let slotIndex = 0;

  let adsAmount = 0;
  let recoilPitch = 0;
  let recoilYaw = 0;

  const muzzleWorld = new THREE.Vector3();
  const aimPoint = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const muzzleDir = new THREE.Vector3();

  /**
   * The muzzle, in world space.
   *
   * The viewmodel lives in its own scene with its own camera, so its muzzle is
   * transformed by that camera's world matrix — which is the identity, because
   * the viewmodel camera never moves. The muzzle is therefore already in "eye
   * space", and the only transform needed is the world camera's.
   *
   * Falls back to the player's eye when there is no viewmodel, so a missing
   * asset degrades to "shots come from your face" rather than crashing.
   */
  function muzzlePosition(): THREE.Vector3 {
    if (!viewmodel) return player.eye;
    muzzleWorld.copy(viewmodel.muzzle).applyMatrix4(camera.matrixWorld);
    return muzzleWorld;
  }

  function aimContext(): AimContext {
    return {
      speed: player.speed,
      crouching: player.crouching,
      // Spread must not tighten for an aim the player cannot actually take.
      aiming: aiming(),
    };
  }

  /** Aiming is refused while reloading: the arms are busy and the sights are down. */
  function aiming(): boolean {
    return input.aiming && !slots[slotIndex].reloading;
  }

  function fireOnce(weapon: Weapon) {
    const origin = muzzlePosition().clone();
    const dir = weapon.tryFire(origin, camDir);
    if (!dir) {
      // An empty magazine auto-reloads on the trigger pull, which is what every
      // shooter does and what players expect. `tryFire` has already started the
      // timer; this plays the matching animation.
      if (weapon.reloading && !viewmodel?.reloading) {
        const clip = viewmodel?.reload(true) ?? 0;
        opts.onReload?.(weapon, clip || weapon.def.reloadTime, true);
      }
      return;
    }

    // The shot travels along the weapon's own (spread-displaced) direction, but
    // the point it is aimed AT is down the camera centre ray. Reconciling the
    // two is what `combat.fire` does.
    muzzleDir.copy(dir);
    aimPoint.copy(camera.position).addScaledVector(camDir, weapon.def.range);

    const hit = combat.fire(self, origin, aimPoint, weapon.def.damage, weapon.def.range);

    effects.muzzleFlash(origin, muzzleDir);
    effects.tracer(origin, hit.point);
    effects.impact(hit);

    // ---- recoil kick, applied to the camera by `camera.ts` ----
    const kick = THREE.MathUtils.degToRad(weapon.recoil.vertical);
    recoilPitch += kick;
    recoilYaw += THREE.MathUtils.degToRad(weapon.recoil.horizontal);

    // ---- viewmodel kick, on top of the camera's recoil ----
    viewmodel?.kick();

    // The SHOOT clip is time-scaled to the fire interval so it finishes exactly
    // as the next round leaves the barrel, rather than being cut off at 600 rpm.
    viewmodel?.shoot(60 / weapon.def.rpm);

    opts.onShot?.(weapon, hit);
  }

  /**
   * Starts a reload, taking the duration from the animation clip.
   *
   * The clip is asked for its length BEFORE the weapon's timer is started, so the
   * two cannot disagree. When there is no viewmodel the weapon falls back to
   * `WEAPONS[id].reloadTime`.
   */
  function beginReload(weapon: Weapon, empty: boolean) {
    const clipDuration = viewmodel?.reload(empty) ?? 0;
    if (weapon.startReload(clipDuration || undefined)) {
      opts.onReload?.(weapon, clipDuration || weapon.def.reloadTime, empty);
    }
  }

  return {
    get current() {
      return slots[slotIndex];
    },
    get slots() {
      return slots;
    },
    get adsAmount() {
      return adsAmount;
    },
    get recoilPitch() {
      return recoilPitch;
    },
    get recoilYaw() {
      return recoilYaw;
    },
    get aiming() {
      return aiming();
    },
    get reloading() {
      return slots[slotIndex].reloading;
    },

    update(dt) {
      // ---- weapon switching ----
      // The SMG is not in WEAPON_ORDER until a second viewmodel exists, so these
      // guards are what keep the player from switching to a weapon they cannot
      // see. See WEAPON_ORDER in config.ts.
      //
      // A weapon switch is one of the two things allowed to cancel a reload.
      if (input.pressed('weapon1') && slotIndex !== 0 && slots.length > 0) {
        viewmodel?.holster();
        slotIndex = 0;
        slots[slotIndex].cancelReload();
        viewmodel?.draw();
      }
      if (input.pressed('weapon2') && slotIndex !== 1 && slots.length > 1) {
        viewmodel?.holster();
        slotIndex = 1;
        slots[slotIndex].cancelReload();
        viewmodel?.draw();
      }

      const weapon = slots[slotIndex];
      const ctx = aimContext();

      // ---- the camera's forward direction drives the aim ----
      camera.getWorldDirection(camDir);

      // ---- inspect (V) ----
      // Ignored during a reload: the clip must play to completion.
      if (input.pressed('inspect')) viewmodel?.inspect();

      // ---- reload ----
      // RELOAD1 when rounds remain, RELOAD2 from empty — the two clips differ
      // precisely because an empty reload has to rack the bolt.
      //
      // Re-pressing R while a reload is already running does nothing. That is
      // deliberate: re-pressing R is how players ask "is it reloading?", and
      // restarting the animation every time would make the reload unfinishable.
      const wasEmpty = weapon.empty;
      if (input.pressed('reload') && !weapon.reloading && weapon.ammo < weapon.def.magazine) {
        beginReload(weapon, wasEmpty);
      }

      // ---- fire ----
      // Automatic weapons fire while held; the weapon's own cooldown enforces
      // the rate of fire, so this can be called every frame. `canFire` refuses
      // while a reload is running, so the trigger cannot interrupt one.
      const wantsFire = input.firing && weapon.def.automatic;
      if (wantsFire && input.pointerLocked) {
        fireOnce(weapon);
      }

      // ---- advance both weapons so the inactive one still recovers spread ----
      for (const w of slots) {
        w.update(dt, w === weapon ? ctx : { speed: 0, crouching: false, aiming: false });
      }

      // ---- ADS blend ----
      // ~0.2 s to full ADS, matching the viewmodel's own hold blend.
      const targetAds = aiming() ? 1 : 0;
      const rate = dt / 0.16;
      adsAmount = THREE.MathUtils.clamp(
        adsAmount + (targetAds > adsAmount ? rate : -rate),
        0,
        1
      );

      // ---- recoil decay, so the kick is a kick and not a drift ----
      const recover = dt * 6;
      recoilPitch = Math.max(0, recoilPitch - recover * 0.6);
      recoilYaw = approach(recoilYaw, 0, recover);
    },

    respawn() {
      for (const w of slots) {
        w.refill();
        w.reset();
      }
      viewmodel?.draw();
    },
  };
}

function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Exported so `camera.ts` can convert the recoil kick into a pitch offset. */
export const RECOIL_TO_PITCH = CAMERA.pitchMax / Math.PI;
