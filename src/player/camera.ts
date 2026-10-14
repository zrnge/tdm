/**
 * First-person camera.
 *
 * The camera sits at the player's eye and looks along the player's own yaw and
 * pitch, plus a purely visual recoil offset. There is no orbit, no shoulder
 * swap and no collision cast: the camera is inside the player's capsule, so
 * there is nothing between it and the world to clip against.
 *
 * ## Eye height
 *
 * Standing is 1.65 m, crouched 1.1 m, blended with a frame-rate-independent
 * damping rather than snapped. With no visible body, that blend IS the crouch
 * feedback — a hard cut between the two heights reads as a teleport.
 *
 * ## Why the camera does not jitter
 *
 * Three separate sources of vertical noise are dealt with here, and each needs a
 * different fix:
 *
 *  1. **Physics steps at 120 Hz, the screen refreshes at 60.** The player's
 *     position is therefore up to one step stale, and reading it directly makes
 *     the camera move in 8.3 ms quanta. `player.ts` publishes an INTERPOLATED
 *     position for exactly this reason, and the camera reads that.
 *  2. **Snap-to-ground and autostep produce sub-centimetre vertical pops** as the
 *     capsule is pulled onto a step edge or re-seated on the floor. These are
 *     real corrections and must not be smoothed away entirely, but they must not
 *     reach the screen either. `verticalSmoothHalfLife` filters them.
 *  3. **A plain lerp would lag a jump** by `v * halfLife / ln 2` — 18 cm at jump
 *     speed, which is a visible float. So the filter switches itself off the
 *     moment the eye's own vertical movement exceeds
 *     `verticalSmoothThreshold` per frame, and a jump passes through untouched.
 *
 * ## Recoil
 *
 * `setRecoil` is added to the view angles here rather than to `player.pitch` so
 * it is purely visual: the crosshair kicks and settles, but the player's own aim
 * direction is never permanently displaced by firing.
 */
import * as THREE from 'three';
import { CAMERA, PLAYER } from '../config';
import { BOB_SCALE, type Settings } from '../game/settings';
import type { Player } from '../player/player';
import { bobPhaseStep } from './gait';

export interface FirstPersonCamera {
  update(dt: number): void;
  /**
   * Whether the player is aiming down sights, which drives the FOV zoom.
   *
   * Set by `main.ts` from the weapon state rather than read here, so this module
   * stays free of an input dependency and can be unit-tested with a stub.
   */
  setAiming(aiming: boolean): void;
  /**
   * Extra pitch/yaw applied on top of the player's look, in radians.
   *
   * Weapon recoil is added here rather than to `player.pitch` so it is purely
   * visual: the crosshair kicks and settles, but the player's own aim direction
   * is never permanently displaced by firing.
   */
  setRecoil(pitch: number, yaw: number): void;
  /** Current eye height above the feet, metres. Smoothed, so it lags a crouch. */
  readonly eyeHeight: number;
  /** Current bob phase, radians. The viewmodel reads this so the two agree. */
  readonly bobPhase: number;
  /** Current bob amplitude, 0..~1.8. */
  readonly bobAmount: number;
  dispose(): void;
}

/** Smoothing that is stable regardless of frame rate. */
function damp(current: number, target: number, halfLife: number, dt: number): number {
  return target + (current - target) * Math.pow(2, -dt / halfLife);
}

export function createFirstPersonCamera(
  player: Player,
  camera: THREE.PerspectiveCamera,
  settings: Settings
): FirstPersonCamera {
  // Recoil is a visual offset, layered on top of the player's own look angles.
  let recoilPitch = 0;
  let recoilYaw = 0;
  let currentFov: number = CAMERA.fov;
  let eyeHeight: number = PLAYER.eyeHeight;
  let initialised = false;
  let aiming = false;

  // Vertical smoothing state. `smoothedEyeY` is the eye height actually drawn;
  // `lastRawEyeY` is what the physics produced, used to decide whether the player
  // is genuinely moving vertically.
  let smoothedEyeY = 0;
  let lastRawEyeY = 0;

  // Bob state, shared with the viewmodel so the weapon and the camera cannot
  // disagree about where the feet are.
  let bobPhase = 0;
  let bobAmount = 0;

  const lookDir = new THREE.Vector3();

  function update(dt: number) {
    // ---- eye height: 1.65 m standing, 1.1 m crouched, blended ----
    const targetEye = player.crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
    if (!initialised) {
      eyeHeight = targetEye;
      initialised = true;
    } else {
      eyeHeight = damp(eyeHeight, targetEye, PLAYER.eyeTransitionHalfLife, dt);
    }

    // ---- the eye, from the INTERPOLATED capsule position ----
    // `player.cameraAnchor` is the capsule centre with NO forward offset, so the
    // camera is always exactly on the capsule's vertical axis. The eye is a
    // purely vertical offset from it. See the module comment.
    const totalHeight = player.crouching ? PLAYER.crouchHeight : PLAYER.height;
    const rawEyeY = player.cameraAnchor.y - totalHeight / 2 + eyeHeight;

    if (!initialised) {
      smoothedEyeY = rawEyeY;
    } else {
      // Only filter while the eye is essentially stationary vertically. A jump,
      // a fall or a step down all move far faster than the threshold and pass
      // through unsmoothed — which is what keeps a jump feeling immediate.
      const moved = Math.abs(rawEyeY - lastRawEyeY);
      if (moved < CAMERA.verticalSmoothThreshold) {
        smoothedEyeY = damp(smoothedEyeY, rawEyeY, CAMERA.verticalSmoothHalfLife, dt);
      } else {
        smoothedEyeY = rawEyeY;
      }
    }
    lastRawEyeY = rawEyeY;

    // ---- camera bob: almost nothing, by design ----
    // The weapon carries the walk motion (see VIEWMODEL.bob); this is only the
    // hint of it that makes the world feel attached to the player's feet. The
    // amplitude is 0.4 cm walking and 0.7 cm sprinting, and there is no roll at
    // all — roll is what makes a bob read as "bouncing on every step". The rate
    // is a real footstep cadence (gait.ts), so a sprint bobs ~2.7 times a
    // second, not 6.4.
    const speed = player.speed;
    if (player.grounded && speed > 0.15) {
      bobPhase += bobPhaseStep(speed, dt);
      const target = THREE.MathUtils.clamp(speed / PLAYER.walkSpeed, 0, 2);
      bobAmount = damp(bobAmount, target, 0.12, dt);
    } else {
      bobAmount = damp(bobAmount, 0, 0.1, dt);
    }

    const sprintBlend = THREE.MathUtils.clamp(
      (speed - PLAYER.walkSpeed) / Math.max(PLAYER.sprintSpeed - PLAYER.walkSpeed, 1e-3),
      0,
      1
    );
    const amplitude = THREE.MathUtils.lerp(
      CAMERA.bob.walkAmplitude,
      CAMERA.bob.sprintAmplitude,
      sprintBlend
    );
    const bobScale = BOB_SCALE[settings.values.cameraBob];
    const bobY = Math.sin(bobPhase * 2) * amplitude * bobAmount * bobScale;

    // X and Z come straight from the capsule centre — never offset forward, or
    // the camera leaves the collision volume and can enter a wall.
    camera.position.set(player.cameraAnchor.x, smoothedEyeY + bobY, player.cameraAnchor.z);

    // ---- look direction: the player's own aim, plus the recoil kick ----
    const yaw = player.yaw + recoilYaw;
    const pitch = THREE.MathUtils.clamp(
      player.pitch + recoilPitch,
      CAMERA.pitchMin,
      CAMERA.pitchMax
    );
    const cp = Math.cos(pitch);
    // The player faces -Z at yaw 0, matching `player.forward`.
    lookDir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    camera.lookAt(
      camera.position.x + lookDir.x,
      camera.position.y + lookDir.y,
      camera.position.z + lookDir.z
    );

    // ---- aim-down-sights zoom: 75 -> 55 degrees ----
    const targetFov: number = aiming ? CAMERA.adsFov : CAMERA.fov;
    const nextFov = damp(currentFov, targetFov, CAMERA.adsFovHalfLife, dt);
    if (Math.abs(nextFov - currentFov) > 0.01) {
      currentFov = nextFov;
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    }
  }

  return {
    update,
    setAiming(next) {
      aiming = next;
    },
    setRecoil(pitch, yaw) {
      recoilPitch = pitch;
      recoilYaw = yaw;
    },
    get eyeHeight() {
      return eyeHeight;
    },
    get bobPhase() {
      return bobPhase;
    },
    get bobAmount() {
      return bobAmount;
    },
    dispose() {
      /* Nothing to release: the camera is owned by the engine. */
    },
  };
}
