/**
 * Player: Rapier kinematic capsule + manual movement integration.
 *
 * The player is FIRST-PERSON and has no visible body. The capsule below is
 * therefore purely a collision and hit-detection volume: it stops the player
 * walking through walls, and `src/player/hitbox.ts` gives it a matching
 * raycastable proxy so bots can shoot and headshot the player. Nothing about it
 * is ever drawn.
 *
 * Rapier's `KinematicCharacterController` handles the capsule-vs-world sweep,
 * step-up over kerbs, and slope handling for us. Velocity, acceleration,
 * friction, jumping, coyote time and crouching are integrated by hand so the
 * feel is tuned rather than emergent.
 *
 * ## Why there are two positions
 *
 * `position` is the authoritative capsule centre. `renderPosition` is the
 * position to DRAW at, and the camera and hitbox read that one.
 *
 * They are currently identical, and that is not an omission. The usual reason to
 * separate them is that physics advances in whole 1/120 s steps while the screen
 * refreshes on its own clock, so a body's position only changes on the frames
 * that happened to run a step. That does not apply here: `position` is not read
 * back from the rigid body, it is COMPUTED every frame as
 * `body.translation() + corrected`, so it already advances on the render clock.
 * Lerping it by the physics accumulator's fraction would be a forward
 * extrapolation between two frame positions, which adds jitter rather than
 * removing it.
 *
 * The seam is kept because the bots in Phase 3 will need it — they are driven by
 * the navmesh rather than by this controller, and their render positions really
 * will need interpolating.
 *
 * The vertical noise that DOES reach the screen comes from the character
 * controller's snap-to-ground and autostep, which produce sub-centimetre
 * corrections on flat floor. That is filtered in `camera.ts`, where the filter can
 * tell a real jump from a step correction.
 *
 * ## Acceleration
 *
 * Acceleration and deceleration are TIME-based rather than acceleration-based:
 * reaching the target speed takes `accelTime` seconds whatever that target is.
 * With a fixed m/s^2 the sprint would spin up 1.7x slower than the walk, which
 * reads as sluggish rather than heavy.
 */
import * as THREE from 'three';
import { CAMERA, PLAYER } from '../config';
import { RAPIER, type Physics } from '../core/physics';
import type { InputState } from '../core/input';

export interface Player {
  /** Capsule centre, world space. Authoritative; advances on physics steps. */
  readonly position: THREE.Vector3;
  /**
   * Capsule centre to draw at. The camera and the hitbox read this one.
   *
   * Currently identical to `position` — see the module comment for why
   * interpolating it would make the jitter worse rather than better.
   */
  readonly renderPosition: THREE.Vector3;
  /**
   * Where the camera is placed: the capsule centre, with NO forward offset.
   *
   * The eye is a purely VERTICAL offset from this point. Offsetting the camera
   * forward would push it outside the collision capsule, which is how a camera
   * ends up inside a wall — so the rule is enforced here, in one place, rather
   * than by the camera reading the right two fields by hand.
   */
  readonly cameraAnchor: THREE.Vector3;
  /** Unit vector the player faces, on the XZ plane. */
  readonly forward: THREE.Vector3;
  /** Eye position, world space — where the camera sits and where bots aim. */
  readonly eye: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly grounded: boolean;
  readonly crouching: boolean;
  readonly sprinting: boolean;
  /** Horizontal speed in m/s, for spread and weapon bob. */
  readonly speed: number;
  /** Rapier handle of the player's rigid body, so casts can exclude it. */
  readonly bodyHandle: number;
  /** Current capsule total height, metres. Shrinks when crouched. */
  readonly capsuleHeight: number;
  /** Yaw/pitch the player is looking along, radians. */
  yaw: number;
  pitch: number;
  update(dt: number): void;
  teleport(to: THREE.Vector3): void;
  dispose(): void;
}

/** Capsule half-height (the cylinder part) for a given total height. */
function halfHeightFor(totalHeight: number, radius: number) {
  return Math.max(totalHeight / 2 - radius, 0.05);
}

/**
 * Skin width the character controller keeps between the capsule and the world,
 * metres. Passed to `createCharacterController`.
 */
export const CONTROLLER_OFFSET = 0.02;

/**
 * How close the CAMERA can get to a vertical wall, metres.
 *
 * This is NOT the capsule radius, and assuming it was is what let the world
 * camera's near plane (0.3 m) sit almost exactly on the camera's real clearance
 * (0.302 m) — so pressing into a container sliced its wall away with the near
 * plane and you could see inside it.
 *
 * The eye sits inside the capsule's TOP HEMISPHERE, where the horizontal radius
 * has shrunk to `sqrt(r^2 - h^2)` for `h` the eye's height above the cylinder.
 * With the shipped numbers that is `sqrt(0.35^2 - 0.20^2) = 0.287 m`, plus the
 * controller's skin.
 *
 * Exported so `main.ts` can log it next to `CAMERA.near` and prove the two agree.
 */
export function eyeWallClearance(): number {
  const halfHeight = halfHeightFor(PLAYER.height, PLAYER.radius);
  const eyeAboveCylinder = PLAYER.eyeHeight - (PLAYER.height / 2 + halfHeight);
  const horizontal =
    eyeAboveCylinder > 0
      ? Math.sqrt(Math.max(PLAYER.radius * PLAYER.radius - eyeAboveCylinder * eyeAboveCylinder, 0))
      : PLAYER.radius;
  return horizontal + CONTROLLER_OFFSET;
}

export function createPlayer(
  physics: Physics,
  input: InputState,
  spawn: THREE.Vector3
): Player {
  const radius = PLAYER.radius;

  const { body, collider } = physics.createCharacterBody(
    new THREE.Vector3(spawn.x, spawn.y + PLAYER.height / 2, spawn.z),
    halfHeightFor(PLAYER.height, radius),
    radius
  );
  // `createCollider` returns a Collider OBJECT, not a handle — the old name
  // `colliderHandle` is what let the crouch bug hide for so long. See
  // `resizeCapsule` for what that cost.
  const capsuleCollider = physics.world.createCollider(collider, body);
  physics.tag(capsuleCollider, { kind: 'character', entityId: 'player', part: 'body' });

  const controller = physics.world.createCharacterController(CONTROLLER_OFFSET);
  controller.setUp({ x: 0, y: 1, z: 0 });
  controller.enableAutostep(0.45, 0.25, true);
  controller.enableSnapToGround(0.35);
  controller.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
  controller.setMinSlopeSlideAngle((38 * Math.PI) / 180);
  controller.setApplyImpulsesToDynamicBodies(true);
  controller.setCharacterMass(78);

  const velocity = new THREE.Vector3();
  const desired = new THREE.Vector3();
  /**
   * The point the camera is placed at, kept as a named vector so the "camera is
   * exactly at the capsule's horizontal centre" rule is enforced in ONE place
   * rather than by the camera reading the right two fields by hand.
   *
   * It is the capsule centre with no forward offset of any kind: the eye is a
   * vertical offset only. A forward offset would put the camera outside the
   * collision capsule, which is how cameras end up inside walls.
   */
  const cameraAnchor = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
  const position = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
  const renderPosition = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
  const forward = new THREE.Vector3(0, 0, -1);
  const eye = new THREE.Vector3();

  let grounded = false;
  let crouching = false;
  let sprinting = false;
  let speed = 0;
  let yaw = 0;
  let pitch = 0;
  let sinceGrounded = 0;
  let currentHalfHeight = halfHeightFor(PLAYER.height, radius);

  const moveDir = new THREE.Vector3();

  function update(dt: number) {
    // ---- look ----
    if (input.pointerLocked) {
      yaw -= input.mouseDX * CAMERA.sensitivity;
      pitch -= input.mouseDY * CAMERA.sensitivity;
      pitch = THREE.MathUtils.clamp(pitch, CAMERA.pitchMin, CAMERA.pitchMax);
    }

    // ---- crouch (only stand up when there is room) ----
    const wantsCrouch = input.active('crouch');
    if (wantsCrouch && !crouching) {
      crouching = true;
      resizeCapsule(PLAYER.crouchHeight);
    } else if (!wantsCrouch && crouching && canStandUp()) {
      crouching = false;
      resizeCapsule(PLAYER.height);
    }

    // ---- desired horizontal movement, relative to yaw ----
    moveDir.set(0, 0, 0);
    if (input.active('forward')) moveDir.z -= 1;
    if (input.active('back')) moveDir.z += 1;
    if (input.active('left')) moveDir.x -= 1;
    if (input.active('right')) moveDir.x += 1;
    if (moveDir.lengthSq() > 0) moveDir.normalize().applyAxisAngle(UP, yaw);

    sprinting = input.active('sprint') && !crouching && moveDir.lengthSq() > 0;

    const targetSpeed = crouching
      ? PLAYER.crouchSpeed
      : sprinting
        ? PLAYER.sprintSpeed
        : PLAYER.walkSpeed;

    // ---- horizontal acceleration / friction ----
    // Time-based: reaching the target takes `accelTime` seconds regardless of
    // whether that target is a walk or a sprint. See the module comment.
    const targetVX = moveDir.x * targetSpeed;
    const targetVZ = moveDir.z * targetSpeed;

    if (moveDir.lengthSq() > 0) {
      const accel = grounded ? targetSpeed / PLAYER.accelTime : PLAYER.airAccel;
      velocity.x = approach(velocity.x, targetVX, accel * dt);
      velocity.z = approach(velocity.z, targetVZ, accel * dt);
    } else if (grounded) {
      // Deceleration is proportional to the speed being shed, so a stop always
      // takes `decelTime` seconds rather than being instant from a crawl and slow
      // from a sprint.
      const decel = Math.max(PLAYER.walkSpeed, speed) / PLAYER.decelTime;
      velocity.x = approach(velocity.x, 0, decel * dt);
      velocity.z = approach(velocity.z, 0, decel * dt);
    }

    // ---- jump, with coyote time ----
    if (
      input.pressed('jump') &&
      !crouching &&
      (grounded || sinceGrounded < PLAYER.coyoteTime)
    ) {
      velocity.y = PLAYER.jumpVelocity;
      grounded = false;
    }

    // ---- gravity ----
    velocity.y += PLAYER.gravity * dt;
    if (velocity.y < PLAYER.maxFallSpeed) velocity.y = PLAYER.maxFallSpeed;

    // ---- sweep the capsule through the world ----
    desired.copy(velocity).multiplyScalar(dt);
    controller.computeColliderMovement(capsuleCollider, {
      x: desired.x,
      y: desired.y,
      z: desired.z,
    });

    const corrected = controller.computedMovement();
    const t = body.translation();
    const nextX = t.x + corrected.x;
    const nextY = t.y + corrected.y;
    const nextZ = t.z + corrected.z;
    body.setNextKinematicTranslation({ x: nextX, y: nextY, z: nextZ });
    const blockedY = Math.abs(corrected.y - desired.y) > 1e-4;
    const wasFalling = velocity.y <= 0;
    grounded = controller.computedGrounded() || (blockedY && wasFalling);
    if (grounded) {
      sinceGrounded = 0;
      if (velocity.y < 0) velocity.y = 0;
    } else {
      sinceGrounded += dt;
    }
    // Ceiling bump: stop upward motion.
    if (blockedY && velocity.y > 0) velocity.y = 0;

    // ---- publish state ----
    position.set(nextX, nextY, nextZ);
    forward.set(0, 0, -1).applyAxisAngle(UP, yaw);
    speed = Math.hypot(velocity.x, velocity.z);

    // ---- the position the camera and hitbox read ----
    // This is deliberately NOT a lerp between physics steps, and the reason is
    // worth writing down because the textbook answer does not apply here.
    //
    // The usual jitter is: physics advances in whole 1/120 s steps, the screen
    // refreshes on its own clock, so the body's position only changes on the
    // frames that happened to run a step. At 144 Hz (dt = 6.9 ms < 8.3 ms) some
    // frames run one step and some run none, and the camera visibly beats.
    //
    // That does not happen here, because `position` is not read back from the
    // body — it is COMPUTED, every frame, as `body.translation() + corrected`.
    // The body's own translation only moves on a step, but this value advances on
    // every frame regardless, so it is already on the render clock. Lerping it by
    // `physics.alpha` would be a forward extrapolation between two frame
    // positions, which adds jitter instead of removing it.
    //
    // The vertical noise that does reach the screen comes from the character
    // controller's snap-to-ground and autostep, which produce sub-centimetre
    // corrections on flat floor. Those are filtered in `camera.ts`, where the
    // filter can tell a real jump from a step correction.
    renderPosition.copy(position);
    cameraAnchor.copy(position);

    // Feet are at capsule centre minus half the capsule's total height.
    const halfTotal = currentHalfHeight + radius;
    eye.set(
      renderPosition.x,
      renderPosition.y - halfTotal + (crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight),
      renderPosition.z
    );
  }

  function resizeCapsule(totalHeight: number) {
    const half = halfHeightFor(totalHeight, radius);
    const previousHalf = currentHalfHeight;
    const t = body.translation();
    // Keep the feet planted. The feet sit at `centre - (half + radius)`, so
    // holding them still means the centre moves by the NEGATIVE of the change in
    // half-height: shrinking the capsule (half 0.55 -> 0.225) must LOWER the
    // centre by 0.325 m.
    //
    // This sign was inverted, which threw the capsule 0.65 m into the air on
    // every crouch — twice the half-height change, because the error is the
    // difference between moving down 0.325 and moving up 0.325.
    const newY = t.y - (previousHalf - half);
    currentHalfHeight = half;
    body.setTranslation({ x: t.x, y: newY, z: t.z }, true);

    // Resize the EXISTING collider rather than freeing it and making a new one.
    //
    // The old code did `removeCollider(colliderHandle)` then created a
    // replacement into a NEW variable, leaving `colliderHandle` pointing at the
    // freed collider. Every later `computeColliderMovement(colliderHandle, …)`
    // was therefore handed a dead collider and returned zero movement — the
    // player froze on the first crouch and never moved again, even standing up.
    // Mutating in place makes that whole class of bug impossible: there is only
    // ever one collider object, and it is never stale.
    capsuleCollider.setHalfHeight(half);

    // A crouch is a teleport as far as anything downstream is concerned; without
    // this the capsule would visibly slide from the old height to the new one.
    position.y = newY;
    renderPosition.y = newY;
  }

  /** A cheap "is there headroom" test: does a standing capsule overlap anything? */
  function canStandUp(): boolean {
    const t = body.translation();
    const standingHalf = halfHeightFor(PLAYER.height, radius);
    const delta = standingHalf - currentHalfHeight;
    if (delta <= 0) return true;

    // Probe a standing capsule centred where the head would be. Anything found
    // that is not the player's own body means there is no room to stand.
    const shape = new RAPIER.Capsule(standingHalf, radius);
    const hit = physics.world.intersectionWithShape(
      { x: t.x, y: t.y + delta, z: t.z },
      IDENTITY_ROT,
      shape,
      undefined,
      undefined,
      undefined,
      body,
      (collider) => collider.parent()?.handle !== body.handle
    );
    return hit === null;
  }

  return {
    get position() {
      return position;
    },
    get renderPosition() {
      return renderPosition;
    },
    get cameraAnchor() {
      return cameraAnchor;
    },
    get forward() {
      return forward;
    },
    get eye() {
      return eye;
    },
    get velocity() {
      return velocity;
    },
    get grounded() {
      return grounded;
    },
    get crouching() {
      return crouching;
    },
    get sprinting() {
      return sprinting;
    },
    get speed() {
      return speed;
    },
    get bodyHandle() {
      return body.handle;
    },
    get capsuleHeight() {
      return currentHalfHeight * 2 + radius * 2;
    },
    get yaw() {
      return yaw;
    },
    set yaw(v: number) {
      yaw = v;
    },
    get pitch() {
      return pitch;
    },
    set pitch(v: number) {
      pitch = v;
    },
    update,
    teleport(to: THREE.Vector3) {
      position.copy(to);
      renderPosition.copy(to);
      velocity.set(0, 0, 0);
      body.setTranslation(
        { x: to.x, y: to.y + currentHalfHeight + radius, z: to.z },
        true
      );
    },
    dispose() {
      physics.world.removeCharacterController(controller);
      physics.world.removeRigidBody(body);
    },
  };
}

const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 };

function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}
