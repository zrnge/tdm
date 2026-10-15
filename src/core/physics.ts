/**
 * Rapier physics world wrapper.
 *
 * Owns the world, the fixed-timestep accumulator, and a registry of colliders
 * tagged with gameplay metadata (so Phase 2 can resolve "what did I hit?" to a
 * character). Colliders are created through helpers here so the tag is never
 * forgotten.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';

/**
 * Gameplay meaning attached to a Rapier collider handle.
 *
 * `blocker` is a movement-only volume: it stops characters and shapes the
 * navmesh, but bullets and line of sight pass through it. A pallet rack is the
 * case — one solid box keeps everyone out of the shelving, while its open bays
 * stay see-through and shoot-through; thin `prop` colliders on the uprights and
 * decks are what actually stop a round.
 */
export interface ColliderTag {
  kind: 'world' | 'character' | 'prop' | 'blocker';
  /** Set for characters: which combatant owns this collider. */
  entityId?: string;
  /** Set for characters: which body part, used for headshot detection. */
  part?: 'body' | 'head';
  /** What a bullet striking this collider hits, for the impact effect and mark. */
  surface?: 'metal' | 'concrete' | 'wood';
}

export interface Physics {
  readonly world: RAPIER.World;
  /**
   * Fraction of a fixed step still sitting in the accumulator, 0..1.
   *
   * This is the interpolation factor for anything drawn between physics steps.
   * Physics advances in whole 1/120 s steps, but the screen refreshes on its own
   * clock, so a frame almost never lands exactly on a step boundary. Drawing the
   * raw post-step position makes the camera move in 8.3 ms quanta — a fine
   * vertical shimmer while walking. `player.ts` lerps its render position by this
   * value instead.
   */
  readonly alpha: number;
  /** Advances the simulation by exactly `dt` seconds of fixed steps. */
  step(dt: number): void;
  /** Creates a fixed rigid body at the origin; add colliders to it. */
  createFixedBody(): RAPIER.RigidBody;
  /** Creates a kinematic capsule body used by characters. */
  createCharacterBody(position: THREE.Vector3, halfHeight: number, radius: number): {
    body: RAPIER.RigidBody;
    collider: RAPIER.ColliderDesc;
  };
  /** Attaches gameplay meaning to a collider handle. */
  tag(collider: RAPIER.Collider, tag: ColliderTag): void;
  /** Reads back the tag for a collider handle, if any. */
  tagOf(collider: RAPIER.Collider): ColliderTag | undefined;
  /**
   * Ray-query filter predicate for bullets and sight lines: false for
   * movement-only `blocker` volumes. Pass it as `castRay`'s `filterPredicate`.
   */
  readonly blocksRays: (collider: RAPIER.Collider) => boolean;
  dispose(): void;
}

/** 120 Hz fixed step keeps the character controller stable on stairs. */
const FIXED_DT = 1 / 120;
/** Never simulate more than this many steps in one frame (spiral-of-death guard). */
const MAX_STEPS = 8;

export async function createPhysics(): Promise<Physics> {
  await RAPIER.init();

  const world = new RAPIER.World({ x: 0, y: -22, z: 0 });
  world.integrationParameters.numSolverIterations = 4;

  const tags = new Map<number, ColliderTag>();
  let accumulator = 0;
  const blocksRays = (collider: RAPIER.Collider) => tags.get(collider.handle)?.kind !== 'blocker';

  return {
    world,

    get alpha() {
      return accumulator / FIXED_DT;
    },

    step(dt: number) {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
        world.step();
        accumulator -= FIXED_DT;
        steps++;
      }
      // If we hit the step cap, drop the backlog rather than accumulate debt.
      if (steps === MAX_STEPS) accumulator = 0;
    },

    createFixedBody() {
      return world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    },

    createCharacterBody(position, halfHeight, radius) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
          position.x,
          position.y,
          position.z
        )
      );
      const collider = RAPIER.ColliderDesc.capsule(halfHeight, radius)
        .setFriction(0.2)
        .setRestitution(0);
      return { body, collider };
    },

    tag(collider, tag) {
      tags.set(collider.handle, tag);
    },

    tagOf(collider) {
      return tags.get(collider.handle);
    },

    blocksRays,

    dispose() {
      tags.clear();
      world.free();
    },
  };
}

export { RAPIER };
