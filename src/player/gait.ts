/**
 * Footstep cadence, shared by the camera bob and the viewmodel bob so the two
 * always land on the same footstep.
 *
 * ## Why cadence and not distance
 *
 * The bob used to advance per METRE travelled. That makes the step rate scale
 * linearly with speed, and at the 6.4 m/s sprint the view bounced 6.4 times a
 * second — more than double a real runner's ~2.8 steps a second, which reads
 * as the camera shaking rather than as running.
 *
 * Real people go faster mostly by lengthening their stride, not by stepping
 * faster: cadence only rises from ~2 to ~3 steps/s between a brisk walk and a
 * sprint. So the bob runs on a cadence that rises gently with speed, and slows
 * further below walking pace so creeping forward does not patter.
 */
import * as THREE from 'three';
import { CAMERA, PLAYER } from '../config';

/** Footsteps per second at `speed` m/s. */
export function stepsPerSecond(speed: number): number {
  const { walkCadence, sprintCadence } = CAMERA.bob;
  if (speed <= PLAYER.walkSpeed) {
    // Below walking pace, both stride and cadence shrink; sqrt splits the
    // slow-down between them.
    return walkCadence * Math.sqrt(Math.max(speed, 0) / PLAYER.walkSpeed);
  }
  const t = (speed - PLAYER.walkSpeed) / Math.max(PLAYER.sprintSpeed - PLAYER.walkSpeed, 1e-3);
  return THREE.MathUtils.lerp(walkCadence, sprintCadence, THREE.MathUtils.clamp(t, 0, 1));
}

/**
 * Radians of bob phase to advance this frame. One phase cycle is one full
 * stride (two footsteps): vertical bob uses `sin(2 * phase)`, one dip per step,
 * and the lateral sway uses `sin(phase)`, one swing per stride.
 */
export function bobPhaseStep(speed: number, dt: number): number {
  return dt * (stepsPerSecond(speed) / 2) * Math.PI * 2;
}
