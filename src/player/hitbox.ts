/**
 * The player's invisible hit proxy.
 *
 * The player is first-person and has no visible body, but bots still have to be
 * able to shoot them — and to headshot them. `combat.ts` resolves character hits
 * with a Three.js raycast against each combatant's meshes, so the player needs
 * meshes to raycast against even though nothing is drawn.
 *
 * This builds a capsule (body) and a sphere (head) that follow the player's
 * capsule every frame. They are made non-rendering with `material.visible =
 * false` rather than `object.visible = false`: the renderer skips a mesh whose
 * material is invisible, while the object stays visible to the raycaster, so
 * there is no dependence on whether this Three.js version's raycaster honours
 * the visibility flag.
 *
 * The head sphere sits at the eye height, which is where the camera is — so a
 * bot that can see the player's viewpoint can headshot it, exactly as it should.
 */
import * as THREE from 'three';
import { PLAYER } from '../config';
import type { Player } from './player';

export interface PlayerHitbox {
  /** The object `combat.ts` raycasts against. */
  root: THREE.Group;
  /** Meshes that count as a headshot. */
  headMeshes: THREE.Object3D[];
  /** Meshes that count as a body hit. */
  bodyMeshes: THREE.Object3D[];
  /** Follows the player. Call once per frame. */
  update(player: Player): void;
  dispose(): void;
}

/** Body capsule: feet to chest. The head is a separate sphere above it. */
const BODY_TOP = 1.5;
const HEAD_RADIUS = 0.13;

export function createPlayerHitbox(): PlayerHitbox {
  const root = new THREE.Group();
  root.name = 'player-hitbox';

  // Invisible, but still raycastable. See the module comment.
  const bodyMat = new THREE.MeshBasicMaterial();
  bodyMat.visible = false;
  const headMat = new THREE.MeshBasicMaterial();
  headMat.visible = false;

  const radius = PLAYER.radius;
  const bodyLength = Math.max(BODY_TOP - radius * 2, 0.1);
  const bodyGeo = new THREE.CapsuleGeometry(radius, bodyLength, 4, 12);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.name = 'player-hitbox-body';
  // CapsuleGeometry is centred on its own origin, so lift it to span the feet
  // to BODY_TOP.
  body.position.y = BODY_TOP / 2;
  root.add(body);

  const headGeo = new THREE.SphereGeometry(HEAD_RADIUS, 12, 8);
  const head = new THREE.Mesh(headGeo, headMat);
  head.name = 'player-hitbox-head';
  head.position.y = PLAYER.eyeHeight;
  root.add(head);

  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [bodyGeo, headGeo, bodyMat, headMat];

  return {
    root,
    headMeshes: [head],
    bodyMeshes: [body],

    update(player) {
      // The player's `renderPosition` is the capsule centre interpolated for this
      // frame, which is where the camera actually is. Using the raw physics
      // position would put the proxy up to one 120 Hz step away from the viewpoint
      // the player is looking from — a 3 cm disagreement at sprint speed, which is
      // enough to turn a headshot into a miss.
      const half = player.capsuleHeight / 2;
      root.position.set(player.renderPosition.x, player.renderPosition.y - half, player.renderPosition.z);

      // Crouching shrinks the whole proxy vertically. The head sphere becomes a
      // slight ellipsoid, which is invisible and still correct for hit
      // detection — and it keeps the head at the crouched eye height for free.
      const scaleY = player.capsuleHeight / PLAYER.height;
      root.scale.set(1, scaleY, 1);
      root.updateMatrixWorld(true);
    },

    dispose() {
      for (const d of disposables) d.dispose();
      root.removeFromParent();
    },
  };
}
