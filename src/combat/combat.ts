/**
 * Combat: hitscan resolution, damage, health, death and respawn.
 *
 * ## How a shot is resolved
 *
 * Two checks, in this order, exactly as the brief requires:
 *
 *  1. **Line of fire from the muzzle.** A ray from the weapon's muzzle to the
 *     aim point. If the world blocks it, the shot is stopped by cover and never
 *     reaches the target — this is what makes shooting through walls impossible
 *     even when the camera can see over a crate.
 *  2. **Hitscan from the camera centre.** The camera ray is what the player
 *     aimed; it decides *what* was hit and where.
 *
 * ## Why two raycasts and not one
 *
 * The camera sits behind and above the character, so a camera-only ray would
 * happily fire through a wall the character is standing behind. The muzzle ray
 * alone would be wrong too: the muzzle is offset to the right, so it does not
 * point where the crosshair points. Doing both, and requiring the muzzle ray to
 * be clear, gives "you cannot shoot through cover" without the crosshair lying.
 *
 * ## Hit resolution against characters
 *
 * Rapier knows the world (level, cover) and each character's capsule, but the
 * capsule cannot distinguish a head from a torso. So the world hit distance
 * comes from Rapier, and the character hit comes from a Three.js raycast against
 * the character meshes. Whichever is nearer wins. The head bone's mesh is tagged
 * so a hit on it doubles damage.
 */
import * as THREE from 'three';
import { COMBAT, SPAWN, type TeamId } from '../config';
import { RAPIER, type Physics } from '../core/physics';

export interface Combatant {
  id: string;
  team: TeamId;
  /** The object whose meshes are raycast for hit detection. */
  root: THREE.Object3D;
  /** Meshes tagged for headshot detection. */
  headMeshes: THREE.Object3D[];
  /** Meshes that count as body hits. */
  bodyMeshes: THREE.Object3D[];
  /** Feet position, world space. */
  position: THREE.Vector3;
  /** Eye position, world space — where the head actually is. */
  eye: THREE.Vector3;
  /**
   * Rapier handle of this combatant's rigid body.
   *
   * Required so a shot can exclude the shooter's OWN capsule from the
   * line-of-fire ray. Without it the ray starts inside the shooter and Rapier
   * reports a hit at distance 0, which makes every shot look blocked by cover.
   */
  bodyHandle: number;
  health: number;
  alive: boolean;
  /** Seconds of spawn protection remaining. */
  protection: number;
  /** Seconds until respawn, when dead. */
  respawnIn: number;
  kills: number;
  deaths: number;
  assists: number;
  /** Called on death, to play the death animation and hide the body. */
  onDeath?: () => void;
  /** Called on respawn, to restore the character and place it. */
  onRespawn?: (at: THREE.Vector3) => void;
}

export interface HitResult {
  /** The combatant that was hit, if any. */
  target: Combatant | null;
  /** World-space impact point. */
  point: THREE.Vector3;
  /**
   * Surface normal at the impact, for decal orientation. The collider's real
   * normal for world hits; back along the shot for character hits.
   */
  normal: THREE.Vector3;
  /** True when the impact was on a character's head. */
  headshot: boolean;
  /** True when the shot was stopped by world geometry before reaching a target. */
  blocked: boolean;
  /** Distance travelled, metres. */
  distance: number;
  /** What the impact surface was made of, for the right impact effect. */
  surface: 'metal' | 'concrete' | 'wood' | 'flesh';
}

export interface CombatEvents {
  onDamage?(target: Combatant, amount: number, headshot: boolean, attacker: Combatant | null): void;
  onDeath?(target: Combatant, attacker: Combatant | null): void;
  onKill?(attacker: Combatant, target: Combatant, headshot: boolean): void;
  onRespawn?(target: Combatant): void;
}

export interface Combat {
  readonly combatants: Combatant[];
  /** Registers a combatant. */
  add(c: Combatant): void;
  remove(id: string): void;
  byId(id: string): Combatant | undefined;
  /**
   * Resolves one hitscan shot.
   *
   * `origin` is the muzzle, `aimPoint` the point the shooter aimed at (the
   * camera ray's far point). Returns what happened, for effects and scoring.
   */
  fire(
    shooter: Combatant | null,
    origin: THREE.Vector3,
    aimPoint: THREE.Vector3,
    damage: number,
    range: number
  ): HitResult;
  /** Applies damage, honouring spawn protection. */
  damage(target: Combatant, amount: number, headshot: boolean, attacker: Combatant | null): void;
  /** Kills a combatant outright. */
  kill(target: Combatant, attacker: Combatant | null, headshot: boolean): void;
  /** Advances respawn timers and spawn protection. */
  update(dt: number): void;
  /** The combatant whose meshes contain `object`, if any. */
  ownerOf(object: THREE.Object3D): Combatant | undefined;
}

export function createCombat(physics: Physics, events: CombatEvents = {}): Combat {
  const combatants: Combatant[] = [];
  const raycaster = new THREE.Raycaster();
  raycaster.far = 500;

  const tmpDir = new THREE.Vector3();

  /**
   * The combatant that owns `object`, if any.
   *
   * Two passes, and the second is not redundant.
   *
   * The first walks up the parent chain looking for a combatant whose `root` is
   * an ancestor. That is the fast path and it covers the player, whose proxies are
   * direct children of its root.
   *
   * The second checks the head and body mesh lists directly. It exists because a
   * combatant's hit meshes are not always descendants of its `root`: a bot parents
   * its proxies to the rig's BONES (`Head`, `Spine1`) so they follow the animation,
   * which puts them under the rig root and NOT under the empty group they were
   * created in. Relying on the ancestor walk alone made every shot at a bot
   * unattributable — the round was swallowed and reported as blocked by cover, and
   * bots were unkillable.
   */
  function ownerOf(object: THREE.Object3D): Combatant | undefined {
    let node: THREE.Object3D | null = object;
    while (node) {
      const found = combatants.find((c) => c.root === node);
      if (found) return found;
      node = node.parent;
    }
    for (const c of combatants) {
      if (c.headMeshes.some((m) => m === object || isDescendant(object, m))) return c;
      if (c.bodyMeshes.some((m) => m === object || isDescendant(object, m))) return c;
    }
    return undefined;
  }

  /**
   * Distance along `dir` at which the WORLD is hit — level and cover only.
   * Returns Infinity when nothing is in the way.
   *
   * ## Two exclusions, and both are load-bearing
   *
   * `exclude` is the shooter's own rigid body. It MUST be passed: the ray starts
   * at the muzzle, which is inside the shooter's capsule, so without the
   * exclusion Rapier reports an immediate hit at distance 0 and every shot is
   * wrongly treated as blocked by cover.
   *
   * The predicate additionally rejects EVERY character collider, not just the
   * shooter's. This is the subtler of the two and it is what makes bot-vs-player
   * damage work at all.
   *
   * A character's collision capsule is a Rapier collider, so a plain world ray
   * sees it as ordinary geometry. That would be harmless — the capsule is where
   * the body is — except for the ORDER the two hits come back in. The capsule is
   * a 0.35 m radius volume around the character's centre, while the raycastable
   * hit proxy (`hitbox.ts`, `bot.ts`) is a mesh sitting INSIDE it. So the capsule
   * surface is always hit first, a few centimetres nearer:
   *
   *     capsule surface   7.66 m   <- world ray stops here
   *     hitbox mesh       7.69 m   <- character ray reaches here
   *
   * `fire()` then does `hitDistance = min(worldDist, far)` = 7.66, and its
   * character loop breaks on the first hit because `7.692 > 7.66`. The target is
   * never registered, `blocked` comes back true, and the shot is swallowed by the
   * victim's own body. Bots fired 30 rounds into a player standing in the open and
   * dealt zero damage.
   *
   * Filtering characters out here means the world ray answers only the question it
   * is actually asking — "is there cover in the way?" — and character hits are
   * resolved solely by the mesh raycast, which is the thing that knows about heads.
   */
  /** Surface normal of the last `worldHitDistance` hit, world space. */
  const worldNormal = new THREE.Vector3();
  /** Material of the collider the last `worldHitDistance` hit, when tagged. */
  let worldSurface: 'metal' | 'concrete' | 'wood' | undefined;

  /**
   * Distance to the first non-character collider along the ray, or Infinity.
   * Also leaves that surface's normal in `worldNormal`.
   */
  function worldHitDistance(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    exclude?: RAPIER.RigidBody
  ): number {
    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dir.x, y: dir.y, z: dir.z }
    );
    const hit = physics.world.castRayAndGetNormal(
      ray,
      maxDist,
      true,
      undefined,
      undefined,
      undefined,
      exclude,
      // Keep everything that is NOT a character or a movement-only blocker.
      // Rapier calls this per candidate collider and ignores the collider when
      // it returns false.
      (collider) => {
        const kind = physics.tagOf(collider)?.kind;
        return kind !== 'character' && kind !== 'blocker';
      }
    );
    worldSurface = undefined;
    if (!hit) return Infinity;
    worldNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
    worldSurface = physics.tagOf(hit.collider)?.surface;
    return hit.timeOfImpact;
  }

  function fire(
    shooter: Combatant | null,
    origin: THREE.Vector3,
    aimPoint: THREE.Vector3,
    damage: number,
    range: number
  ): HitResult {
    tmpDir.subVectors(aimPoint, origin);
    const aimDistance = tmpDir.length();
    if (aimDistance < 1e-5) {
      return {
        target: null,
        point: origin.clone(),
        normal: new THREE.Vector3(0, 1, 0),
        headshot: false,
        blocked: false,
        distance: 0,
        surface: 'concrete',
      };
    }
    tmpDir.normalize();

    // ---- 1. line of fire: is the muzzle clear? ----
    // The shooter's own body is excluded, or the ray would hit the capsule it
    // starts inside and report every shot as blocked.
    const shooterBody = shooter
      ? physics.world.getRigidBody(shooter.bodyHandle) ?? undefined
      : undefined;
    const worldDist = worldHitDistance(
      origin,
      tmpDir,
      Math.min(range, aimDistance + 1),
      shooterBody
    );
    const blocked = worldDist < aimDistance - 0.05;

    // ---- 2. hitscan against characters, from the aim ray ----
    // The aim ray starts at the muzzle but points at the aim point, so it is
    // the same line the crosshair describes.
    raycaster.set(origin, tmpDir);
    raycaster.far = Math.min(range, aimDistance + 1);

    const candidates: THREE.Object3D[] = [];
    for (const c of combatants) {
      if (!c.alive) continue;
      if (c === shooter) continue;
      if (c.protection > 0) continue;
      candidates.push(c.root);
    }

    // A combatant's hit meshes are not always descendants of its `root`. A bot
    // parents its proxies to the rig's BONES so they follow the animation, which
    // puts them under the rig root rather than under the empty group they were
    // created in. Raycasting `root` alone therefore tested an empty object and
    // every shot at a bot was swallowed. The head and body lists are the
    // authoritative set, so they are added explicitly and de-duplicated.
    const seen = new Set<THREE.Object3D>(candidates);
    for (const c of combatants) {
      if (!c.alive || c === shooter || c.protection > 0) continue;
      for (const m of c.headMeshes) if (!seen.has(m)) { seen.add(m); candidates.push(m); }
      for (const m of c.bodyMeshes) if (!seen.has(m)) { seen.add(m); candidates.push(m); }
    }

    let target: Combatant | null = null;
    let headshot = false;
    let hitDistance = Math.min(worldDist, raycaster.far);

    if (candidates.length) {
      const hits = raycaster.intersectObjects(candidates, true);
      for (const hit of hits) {
        if (hit.distance > hitDistance) break;
        const owner = ownerOf(hit.object);
        if (!owner || owner === shooter) continue;
        target = owner;
        hitDistance = hit.distance;
        headshot = owner.headMeshes.some(
          (m) => m === hit.object || isDescendant(hit.object, m)
        );
        break;
      }
    }

    // ---- resolve the impact point ----
    const point = new THREE.Vector3().copy(origin).addScaledVector(tmpDir, hitDistance);
    const normal =
      !target && Number.isFinite(worldDist) && hitDistance >= worldDist - 1e-4
        ? worldNormal.clone()
        : tmpDir.clone().negate();

    const result: HitResult = {
      target,
      point,
      normal,
      headshot,
      blocked: blocked && !target,
      distance: hitDistance,
      surface: target ? 'flesh' : (worldSurface ?? untaggedSurface(point)),
    };

    if (target) {
      const amount = headshot ? damage * COMBAT.headshotMultiplier : damage;
      applyDamage(target, amount, headshot, shooter);
    }

    return result;
  }

  function applyDamage(
    target: Combatant,
    amount: number,
    headshot: boolean,
    attacker: Combatant | null
  ) {
    if (!target.alive || target.protection > 0) return;
    if (!COMBAT.friendlyFire && attacker && attacker !== target && attacker.team === target.team) return;
    target.health -= amount;
    events.onDamage?.(target, amount, headshot, attacker);
    if (target.health <= 0) {
      target.health = 0;
      kill(target, attacker, headshot);
    }
  }

  function kill(target: Combatant, attacker: Combatant | null, headshot: boolean) {
    if (!target.alive) return;
    target.alive = false;
    target.deaths++;
    target.respawnIn = SPAWN.respawnDelay;
    target.onDeath?.();
    events.onDeath?.(target, attacker);

    if (attacker && attacker !== target) {
      attacker.kills++;
      events.onKill?.(attacker, target, headshot);
    }
  }

  function update(dt: number) {
    for (const c of combatants) {
      if (c.protection > 0) c.protection = Math.max(0, c.protection - dt);
      if (!c.alive) {
        c.respawnIn -= dt;
        if (c.respawnIn <= 0) {
          c.alive = true;
          c.health = COMBAT.maxHealth;
          c.protection = SPAWN.protectionTime;
          events.onRespawn?.(c);
        }
      }
    }
  }

  return {
    combatants,
    add(c) {
      combatants.push(c);
    },
    remove(id) {
      const i = combatants.findIndex((c) => c.id === id);
      if (i >= 0) combatants.splice(i, 1);
    },
    byId(id) {
      return combatants.find((c) => c.id === id);
    },
    fire,
    damage: applyDamage,
    kill,
    update,
    ownerOf,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDescendant(node: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let n: THREE.Object3D | null = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.parent;
  }
  return false;
}

/**
 * Surface for a collider with no `surface` tag: the warehouse's own trimesh,
 * which is one steel shell with the concrete floor at its base. Cover props and
 * the floor slab carry an explicit tag, so a container is never mistaken for a
 * crate by where it happens to stand.
 */
function untaggedSurface(point: THREE.Vector3): 'metal' | 'concrete' {
  return point.y < 0.08 ? 'concrete' : 'metal';
}
