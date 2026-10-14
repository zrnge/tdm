/**
 * Bot AI: perception, human-like aiming, and tactics.
 *
 * ## No cheating
 *
 * Bots fire through the SAME path as the player: `createWeapon()` for fire rate,
 * magazine and spread, and `combat.fire()` for the line-of-fire check. A bot's
 * bullet is stopped by cover exactly like the player's. There is no separate
 * "bot damage" function and no bot-only raycast, which is what makes "bots can't
 * shoot through walls" true by construction rather than by testing.
 *
 * Bots also know only what they could know: what they SEE (vision cone + line
 * of sight), what they HEAR (gunfire, sprinting footsteps, being shot), and what
 * a teammate CALLS OUT. They never read the player's position directly.
 *
 * ## Perception
 *
 * A bot sees a target when all four hold:
 *
 *   1. it is within `range`;
 *   2. it is inside the vision cone, tested in 3D;
 *   3. a raycast from the bot's eye to the target's chest is unobstructed;
 *   4. the target is alive and not spawn-protected.
 *
 * Perception runs at `updateHz` (10 Hz), staggered per bot, not every frame.
 *
 * ## Aiming
 *
 * The bot aims at the target plus an ERROR that starts wide and tightens over
 * `tightenTime` seconds of continuous sight, and widens while the bot moves. The
 * reaction delay is a separate timer started when a target is first acquired.
 *
 * ## Tactics (the state machine)
 *
 *   Patrol    roams toward the middle of the hall, investigating noises and
 *             teammates' callouts on the way.
 *   Engage    target visible: strafes side to side between bursts and plants
 *             its feet to fire, keeps a preferred range, holds fire when a
 *             teammate is in the way. Target lost: pushes the last known
 *             position at a walk, pre-aiming it.
 *   TakeCover hurt, reloading or simply cautious: runs to a cover spot that the
 *             threat cannot see, crouches behind low cover, waits, then PEEKS
 *             (stands up or steps out) back into Engage. Repeats.
 *   Flank     lost sight of the target: swings wide to one side of where it was
 *             last seen instead of walking straight back into its crosshair.
 *   Retreat   badly hurt with no cover in reach: backs off, still shooting.
 *   Reload    reloads, at cover if it can get there; tops up during lulls.
 */
import * as THREE from 'three';
import { BOT, COMBAT, RIFLE, SPAWN, TEAM, type TeamId } from '../config';
import { RAPIER, type Physics } from '../core/physics';
import type { Combat, Combatant } from '../combat/combat';
import { createWeapon, type Weapon } from '../weapons/weapon';
import type { Effects } from '../combat/effects';
import type { NavMeshSystem } from '../nav/navmesh';
import type { CharacterRig } from '../characters/rig';
import { createCharacter } from '../characters/character';
import type { SoldierSource } from '../characters/character';
import type { RifleAsset } from '../weapons/rifleAsset';
import type { CoverProp } from '../level/cover';
import { stepsPerSecond } from '../player/gait';

export type BotState =
  | 'Patrol'
  | 'Engage'
  | 'TakeCover'
  | 'Flank'
  | 'Retreat'
  | 'Reload'
  | 'Dead';

/** Difficulty preset, chosen in the main menu. */
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface DifficultyPreset {
  /** Reaction delay range before the first shot, seconds. */
  reactionMin: number;
  reactionMax: number;
  /** Aim error at first acquisition, degrees. */
  initialError: number;
  /** Aim error after converging, degrees. */
  minError: number;
  /** Seconds of continuous sight to converge. */
  tightenTime: number;
  /** Burst length range, shots. */
  burstMin: number;
  burstMax: number;
  /** Chance of flanking rather than pushing straight when sight is lost. */
  flankChance: number;
  /** Chance of fighting from cover when a fight starts, even unhurt. */
  coverUse: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyPreset> = {
  easy: {
    reactionMin: 0.6,
    reactionMax: 0.8,
    initialError: 12,
    minError: 2.4,
    tightenTime: 1.6,
    burstMin: 2,
    burstMax: 4,
    flankChance: 0.25,
    coverUse: 0.2,
  },
  normal: {
    reactionMin: 0.3,
    reactionMax: 0.5,
    initialError: 8,
    minError: 1.1,
    tightenTime: 1.0,
    burstMin: 3,
    burstMax: 6,
    flankChance: 0.55,
    coverUse: 0.5,
  },
  hard: {
    reactionMin: 0.2,
    reactionMax: 0.3,
    initialError: 5,
    minError: 0.6,
    tightenTime: 0.6,
    burstMin: 5,
    burstMax: 9,
    flankChance: 0.85,
    coverUse: 0.8,
  },
};

export interface Bot {
  readonly id: string;
  readonly team: TeamId;
  readonly state: BotState;
  /** The combatant record, so this bot can be shot and can score kills. */
  readonly combatant: Combatant;
  /** Capsule centre, world space. */
  readonly position: THREE.Vector3;
  /** Eye position, world space. Lower while crouched. */
  readonly eye: THREE.Vector3;
  /** Unit vector the bot faces, on the XZ plane. */
  readonly forward: THREE.Vector3;
  /** Current path as world-space waypoints. Empty when standing still. */
  readonly path: THREE.Vector3[];
  /** World-space velocity, m/s. */
  readonly velocity: THREE.Vector3;
  /** The bot's rifle, for the debug overlay and tests. */
  readonly weapon: Weapon;
  /** The combatant this bot is currently engaging, if any. */
  readonly target: Combatant | null;
  /** Where the bot last saw its target. */
  readonly lastKnown: THREE.Vector3 | null;
  /** True while the bot has unobstructed sight of its target. */
  readonly hasSight: boolean;
  /** True when this bot is investigating a noise or a callout. */
  readonly heard: boolean;
  /** True while crouched behind low cover. */
  readonly crouching: boolean;
  /** The rig, for the debug overlay and animation. */
  readonly rig: CharacterRig;
  /** Sets the difficulty preset. Takes effect immediately. */
  setDifficulty(d: Difficulty): void;
  /** Moves the bot to `to` and clears its path. Used on respawn. */
  teleport(to: THREE.Vector3): void;
  /** Tells the bot a gunshot happened at `at`, so it can turn toward it. */
  hearGunshot(at: THREE.Vector3): void;
  /** A noise of `radius` metres at `at` (footsteps). */
  hearNoise(at: THREE.Vector3, radius: number): void;
  /** A teammate spotted an enemy at `at`. */
  hearCallout(at: THREE.Vector3): void;
  /** This bot was just shot by `attacker`. */
  notifyDamaged(attacker: Combatant | null): void;
  /** An enemy started a reload at `at`, taking `duration` seconds. */
  hearEnemyReload(at: THREE.Vector3, duration: number): void;
  update(dt: number): void;
  dispose(): void;
}

export interface BotManager {
  readonly bots: Bot[];
  /** Every bot combatant, for the scoreboard. */
  readonly combatants: Combatant[];
  /** Creates a bot on `team` at `spawn` and registers it. */
  spawn(id: string, team: TeamId, spawn: THREE.Vector3): Bot;
  /** Tells every bot except the shooter that a gunshot happened. */
  broadcastGunshot(at: THREE.Vector3, shooterId: string): void;
  /** A noise made by `sourceTeam`, heard by the OTHER team within `radius`. */
  broadcastNoise(at: THREE.Vector3, sourceTeam: TeamId, radius: number): void;
  /** Routes a damage event to the bot that was hit. */
  notifyDamaged(targetId: string, attacker: Combatant | null): void;
  /** A reload by `sourceTeam`, heard by the other team. */
  broadcastReload(at: THREE.Vector3, sourceTeam: TeamId, duration: number): void;
  /** Squad state per team, for the debug overlay and tests. */
  readonly squads: ReadonlyMap<TeamId, Squad>;
  setDifficulty(d: Difficulty): void;
  update(dt: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Cover spots
// ---------------------------------------------------------------------------

/** A place to stand behind a prop. Generated once, shared by every bot. */
export interface CoverSpot {
  /** Floor point on the navmesh. */
  position: THREE.Vector3;
  /** Unit vector pointing AWAY from the prop: the side the bot is exposed on. */
  normal: THREE.Vector3;
  /** True when the prop is low enough to crouch behind and pop up over. */
  low: boolean;
  /** Id of the bot using it, so two bots do not pile onto one spot. */
  claimedBy: string | null;
}

/**
 * Nearest navmesh point ON THE FLOOR. The navmesh also covers the tops of
 * containers and racking, and a plain nearest-point query (which searches
 * 2.5 m vertically) happily snaps a floor goal onto one — an island no path
 * reaches, where a bot would stand at the end of a partial path forever.
 */
function floorPoint(navmesh: NavMeshSystem, p: THREE.Vector3, maxDist: number): THREE.Vector3 | null {
  const q = navmesh.nearestPoint(p, maxDist);
  return q && q.y < 0.5 ? q : null;
}

/** The full path from `from` to `to`, or null when only a partial one exists. */
function fullRoute(navmesh: NavMeshSystem, from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] | null {
  const path = navmesh.path(from, to);
  if (!path.length) return null;
  const end = path[path.length - 1];
  return Math.hypot(end.x - to.x, end.z - to.z) < 1 ? path : null;
}

function reachable(navmesh: NavMeshSystem, from: THREE.Vector3, to: THREE.Vector3): boolean {
  return fullRoute(navmesh, from, to) !== null;
}

/** Closest horizontal distance from `p` to a polyline starting at `start`. */
function routeClearance(start: THREE.Vector3, path: THREE.Vector3[], p: THREE.Vector3): number {
  let best = Infinity;
  let ax = start.x;
  let az = start.z;
  for (const b of path) {
    const dx = b.x - ax;
    const dz = b.z - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-6 ? THREE.MathUtils.clamp(((p.x - ax) * dx + (p.z - az) * dz) / len2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - p.x, az + dz * t - p.z));
    ax = b.x;
    az = b.z;
  }
  return best;
}

/**
 * Builds cover spots around every prop that stands on the floor: one or more
 * per face, a body's width out from it, kept only if they land on the navmesh.
 */
export function buildCoverSpots(props: CoverProp[], navmesh: NavMeshSystem): CoverSpot[] {
  const spots: CoverSpot[] = [];
  const q = new THREE.Quaternion();
  const boxes = props.map((p) => {
    const t = p.collider.translation();
    const r = p.collider.rotation();
    q.set(r.x, r.y, r.z, r.w);
    // Props are rotated by 0 or 90 degrees only, so the world AABB is exact.
    const ext = new THREE.Vector3(p.half.x, p.half.y, p.half.z).applyQuaternion(q);
    ext.set(Math.abs(ext.x), Math.abs(ext.y), Math.abs(ext.z));
    return { centre: new THREE.Vector3(t.x, t.y, t.z), ext };
  });

  for (const { centre, ext } of boxes) {
    // Only props resting on the floor; a stacked crate's faces float.
    if (centre.y - ext.y > 0.3) continue;

    // Effective height includes anything stacked on top.
    let top = centre.y + ext.y;
    for (const other of boxes) {
      if (other.centre === centre) continue;
      const overlaps =
        Math.abs(other.centre.x - centre.x) < ext.x &&
        Math.abs(other.centre.z - centre.z) < ext.z &&
        other.centre.y - other.ext.y >= top - 0.15;
      if (overlaps) top = Math.max(top, other.centre.y + other.ext.y);
    }
    const low = top < BOT.tactics.lowCoverHeight;

    for (const [nx, nz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const normal = new THREE.Vector3(nx, 0, nz);
      const along = nx !== 0 ? ext.x : ext.z;
      const across = nx !== 0 ? ext.z : ext.x;
      const tangent = new THREE.Vector3(-nz, 0, nx);
      // A long face (a container's side) gets three spots along it.
      const offsets = across > 1.4 ? [-across * 0.6, 0, across * 0.6] : [0];
      for (const o of offsets) {
        const p = centre
          .clone()
          .addScaledVector(normal, along + BOT.radius + 0.25)
          .addScaledVector(tangent, o)
          .setY(0);
        const snapped = floorPoint(navmesh, p, 0.6);
        if (!snapped) continue;
        if (Math.hypot(snapped.x - p.x, snapped.z - p.z) > 0.4) continue;
        spots.push({ position: snapped, normal, low, claimedBy: null });
      }
    }
  }
  return spots;
}

// ---------------------------------------------------------------------------
// Squad
// ---------------------------------------------------------------------------

/**
 * A team of bots that fight as one.
 *
 * ## Shared intel
 *
 * Every sighting is reported to the squad: where the target was, which way it
 * was moving, and when. A bot that cannot see the target itself still knows
 * where it is for `intelTTL` seconds — the radio — and hunts the PREDICTED
 * position (last seen + velocity x time), so ducking behind a container and
 * running does not shake the whole squad.
 *
 * ## Roles
 *
 * Re-assigned every `roleInterval` seconds:
 *
 *   pin     the bots that can see the target (or the closest one): hold the
 *           angle, fight, and lay suppressive fire on the target's cover so it
 *           cannot re-peek safely while...
 *   flank   ...everyone else swings round to a DIFFERENT side of the target
 *           (left, right, behind), so the target is caught in a pincer.
 *   search  nobody knows where the target is: the hall is split into zones and
 *           each bot sweeps a different one, rotating, instead of four bots
 *           wandering into each other.
 */
export type SquadRole = 'pin' | 'flank' | 'search';

export interface SquadIntel {
  target: Combatant;
  /** Where the target was last seen (capsule centre). */
  position: THREE.Vector3;
  /** Estimated ground velocity, m/s. */
  velocity: THREE.Vector3;
  /** Squad clock time of the last sighting. */
  time: number;
  /** Velocity is estimated between these samples, spaced out for stability. */
  samplePosition: THREE.Vector3;
  sampleTime: number;
}

export interface Squad {
  readonly team: TeamId;
  /** Seconds since the squad was formed. */
  clock: number;
  intel: SquadIntel | null;
  /** Squad clock time each member last saw the target. */
  seenAt: Map<string, number>;
  roles: Map<string, SquadRole>;
  /** Approach point for each flanker. */
  goals: Map<string, THREE.Vector3>;
  /**
   * A waypoint each flanker passes first, out in a side lane. The navmesh
   * always returns the SHORTEST route, which in a hall like this runs straight
   * down the middle at the target; the via-point forces the long way round.
   */
  vias: Map<string, THREE.Vector3>;
  /** The predicted target position the current goals were planned around. */
  goalBase: THREE.Vector3 | null;
  /** Members holding the pin in the current plan. */
  pinners: Set<string>;
  /** Squad clock time the current plan was made, and who was alive for it. */
  planTime: number;
  planMembers: string;
  /** Search zone for each bot while the target's whereabouts are unknown. */
  zones: Map<string, THREE.Vector3>;
  /** Where a combatant is looking, when the game knows (the player's camera). */
  aimOf?: (c: Combatant) => THREE.Vector3 | null;
}

function createSquad(team: TeamId, aimOf?: Squad['aimOf']): Squad {
  return {
    team,
    clock: 0,
    intel: null,
    seenAt: new Map(),
    roles: new Map(),
    goals: new Map(),
    vias: new Map(),
    goalBase: null,
    pinners: new Set(),
    planTime: 0,
    planMembers: '',
    zones: new Map(),
    aimOf,
  };
}

function intelFresh(squad: Squad): boolean {
  const i = squad.intel;
  return !!i && i.target.alive && squad.clock - i.time < BOT.squad.intelTTL;
}

/** A member saw `target` just now. */
function reportSighting(squad: Squad, botId: string, target: Combatant) {
  const now = squad.clock;
  squad.seenAt.set(botId, now);
  const i = squad.intel;
  if (!i || i.target !== target) {
    squad.intel = {
      target,
      position: target.position.clone(),
      velocity: new THREE.Vector3(),
      time: now,
      samplePosition: target.position.clone(),
      sampleTime: now,
    };
    return;
  }
  i.position.copy(target.position);
  i.time = now;
  const dt = now - i.sampleTime;
  if (dt > 0.2) {
    const v = new THREE.Vector3().subVectors(target.position, i.samplePosition).setY(0).divideScalar(dt);
    if (v.length() > 8) v.setLength(8);
    i.velocity.lerp(v, 0.6);
    i.samplePosition.copy(target.position);
    i.sampleTime = now;
  }
}

/** Where the target probably is now: last seen, carried along its velocity. */
function predictedPosition(squad: Squad, out: THREE.Vector3): THREE.Vector3 {
  const i = squad.intel!;
  const age = Math.min(squad.clock - i.time, BOT.squad.predictTime);
  return out.copy(i.position).addScaledVector(i.velocity, age);
}

/** Rotates a horizontal vector about +Y. */
function rotateY(v: THREE.Vector3, degrees: number): THREE.Vector3 {
  const a = THREE.MathUtils.degToRad(degrees);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return v.set(v.x * c + v.z * s, 0, -v.x * s + v.z * c);
}

function assignRoles(squad: Squad, members: Bot[], navmesh: NavMeshSystem) {
  const S = BOT.squad;
  const alive = members.filter((b) => b.combatant.alive);
  squad.roles.clear();

  if (!intelFresh(squad)) {
    squad.intel = null;
    squad.goals.clear();
    squad.vias.clear();
    squad.pinners.clear();
    squad.goalBase = null;
    // Sweep: zones between the two spawns, rotating so the search moves on.
    const own = TEAM[squad.team].spawnCenter.z;
    const other = TEAM[squad.team === 'red' ? 'blue' : 'red'].spawnCenter.z;
    const zones: THREE.Vector3[] = [];
    for (const f of [0.92, 0.6, 0.3]) {
      const z = THREE.MathUtils.lerp(own, other, f);
      zones.push(new THREE.Vector3(-4.5, 0, z), new THREE.Vector3(4.5, 0, z));
    }
    const k = Math.floor(squad.clock / S.searchRotate);
    alive.forEach((b, i) => {
      squad.roles.set(b.id, 'search');
      squad.zones.set(b.id, zones[(i * 2 + k) % zones.length]);
    });
    return;
  }

  const predicted = predictedPosition(squad, new THREE.Vector3());
  const byDistance = [...alive].sort(
    (a, b) => a.position.distanceToSquared(predicted) - b.position.distanceToSquared(predicted)
  );

  // ---- keep the plan, or make a new one ----
  // Roles are STICKY. Re-picking them every half second from whoever happens to
  // see the target that instant had bots flipping between pinning and
  // flanking, and doing neither. A plan stands until the target has moved, the
  // squad has changed, or it has simply gone stale.
  const memberIds = alive.map((b) => b.id).join(',');
  const replan =
    !squad.goalBase ||
    squad.goalBase.distanceTo(predicted) > 4 ||
    squad.planMembers !== memberIds ||
    squad.clock - squad.planTime > 8;
  if (!replan) {
    for (const b of alive) {
      if (squad.pinners.has(b.id)) squad.roles.set(b.id, 'pin');
      else if (squad.goals.has(b.id)) squad.roles.set(b.id, 'flank');
      else squad.roles.set(b.id, 'pin');
    }
    return;
  }

  squad.planTime = squad.clock;
  squad.planMembers = memberIds;
  squad.goals.clear();
  squad.vias.clear();
  squad.pinners.clear();
  squad.goalBase = predicted.clone();

  const seeing = byDistance.filter((b) => squad.clock - (squad.seenAt.get(b.id) ?? -99) < 0.6);
  const pinners = (seeing.length ? seeing : byDistance).slice(0, S.maxPinners);
  for (const p of pinners) {
    squad.pinners.add(p.id);
    squad.roles.set(p.id, 'pin');
  }
  const flankers = byDistance.filter((b) => !pinners.includes(b));
  if (!flankers.length) return;

  // The pinners' line of attack; flankers come in at angles off it.
  const anchor = new THREE.Vector3();
  for (const p of pinners) anchor.add(p.position);
  anchor.divideScalar(pinners.length);
  const base = anchor.sub(predicted).setY(0);
  if (base.lengthSq() < 1e-4) base.set(0, 0, 1);
  base.normalize();

  // Sideways relative to the line of attack, for side-lane via-points.
  const lateral = new THREE.Vector3(-base.z, 0, base.x);

  /**
   * A flank route from `from` to `goal` that keeps clear of the target: direct
   * if the shortest path already does, otherwise through a via-point out to
   * the side. A route that runs past the target is a frontal charge, not a
   * flank, and is rejected.
   */
  const planRoute = (
    from: THREE.Vector3,
    goal: THREE.Vector3
  ): { via: THREE.Vector3 | null; length: number } | null => {
    const direct = fullRoute(navmesh, from, goal);
    if (direct && routeClearance(from, direct, predicted) >= S.flankClearance) {
      return { via: null, length: routeLength(from, direct) };
    }
    const mid = from.clone().add(goal).multiplyScalar(0.5);
    const side = Math.sign(new THREE.Vector3().subVectors(goal, predicted).dot(lateral)) || 1;
    for (const s of [side, -side]) {
      for (const k of [4.5, 6.5]) {
        const via = floorPoint(navmesh, mid.clone().addScaledVector(lateral, s * k).setY(0), 2.5);
        if (!via) continue;
        const a = fullRoute(navmesh, from, via);
        const b = a && fullRoute(navmesh, via, goal);
        if (!a || !b) continue;
        if (routeClearance(from, a, predicted) < S.flankClearance) continue;
        if (routeClearance(via, b, predicted) < S.flankClearance) continue;
        return { via, length: routeLength(from, a) + routeLength(via, b) };
      }
    }
    return null;
  };

  const free: number[] = [...S.flankAngles];
  for (const f of flankers) {
    // Greedy: each flanker takes the free angle with the SHORTEST valid route,
    // so nobody runs across the hall when a teammate is already there.
    const from = new THREE.Vector3(f.position.x, 0, f.position.z);
    let bestIndex = -1;
    let bestGoal: THREE.Vector3 | null = null;
    let bestVia: THREE.Vector3 | null = null;
    let bestLength = Infinity;
    free.forEach((angle, index) => {
      const dir = rotateY(base.clone(), angle);
      for (const r of [S.flankRadius, S.flankRadius * 0.6]) {
        const goal = floorPoint(navmesh, predicted.clone().addScaledVector(dir, r).setY(0), 3);
        if (!goal) continue;
        const route = planRoute(from, goal);
        if (!route) continue;
        if (route.length < bestLength) {
          bestLength = route.length;
          bestGoal = goal;
          bestVia = route.via;
          bestIndex = index;
        }
        break;
      }
    });
    if (!bestGoal || bestIndex < 0) {
      // No way round: this one pins too (and advances until it has sight).
      squad.pinners.add(f.id);
      squad.roles.set(f.id, 'pin');
      continue;
    }
    free.splice(bestIndex, 1);
    squad.goals.set(f.id, bestGoal);
    if (bestVia) squad.vias.set(f.id, bestVia);
    squad.roles.set(f.id, 'flank');
  }
}

function routeLength(start: THREE.Vector3, path: THREE.Vector3[]): number {
  let length = 0;
  let prev = start;
  for (const p of path) {
    length += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  return length;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export interface BotCallbacks {
  /**
   * Called when a bot fires. `origin` is the muzzle, for sound and effects.
   *
   * Carries the shooter's id rather than the `Bot` object: the bot is still being
   * constructed when this closure is created.
   */
  onShot?(shooterId: string, origin: THREE.Vector3, dir: THREE.Vector3, hit: ReturnType<Combat['fire']>): void;
  /** A footstep, for sound. `intensity` is 0..1. */
  onFootstep?(id: string, at: THREE.Vector3, intensity: number): void;
  /** A reload started, for sound. */
  onReload?(id: string, at: THREE.Vector3, duration: number, empty: boolean): void;
}

export interface CreateBotOptions extends BotCallbacks {
  id: string;
  team: TeamId;
  spawn: THREE.Vector3;
  physics: Physics;
  combat: Combat;
  navmesh: NavMeshSystem;
  effects: Effects;
  soldier: SoldierSource | null;
  rifle: RifleAsset | null;
  difficulty: Difficulty;
  /** Shared cover spots. */
  coverSpots: CoverSpot[];
  /** The squad this bot belongs to. */
  squad: Squad;
  /** Called when this bot first spots an enemy, so teammates can be told. */
  onSpotted?(id: string, team: TeamId, at: THREE.Vector3): void;
}

/** Shared scratch vectors; bots update sequentially so this is safe. */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _aimPoint = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _chest = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The point to aim at on a combatant: the chest, or lower when they crouch.
 * Aiming a fixed height above the capsule centre would aim over the top of a
 * crate at someone crouched behind it — and "see" them through it.
 */
function chestOf(c: Combatant, out: THREE.Vector3): THREE.Vector3 {
  const y = Math.min(c.position.y + BOT.aim.aimHeight, c.eye.y - 0.3);
  return out.set(c.position.x, y, c.position.z);
}

export function createBot(opts: CreateBotOptions): Bot {
  const { id, team, physics, combat, navmesh, effects } = opts;
  const T = BOT.tactics;
  const enemyTeam: TeamId = team === 'blue' ? 'red' : 'blue';

  // ---- body: a kinematic capsule, exactly like the player's ----
  const halfHeight = Math.max(BOT.height / 2 - BOT.radius, 0.05);
  const halfTotal = halfHeight + BOT.radius;
  const { body, collider } = physics.createCharacterBody(
    new THREE.Vector3(opts.spawn.x, opts.spawn.y + BOT.height / 2, opts.spawn.z),
    halfHeight,
    BOT.radius
  );
  const colliderHandle = physics.world.createCollider(collider, body);
  physics.tag(colliderHandle, { kind: 'character', entityId: id, part: 'body' });

  const controller = physics.world.createCharacterController(0.02);
  controller.setUp({ x: 0, y: 1, z: 0 });
  controller.enableAutostep(0.45, 0.25, true);
  controller.enableSnapToGround(0.35);
  controller.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
  controller.setMinSlopeSlideAngle((38 * Math.PI) / 180);

  // ---- the visible body ----
  const rig = createCharacter({ team, soldier: opts.soldier, rifle: opts.rifle });
  rig.root.name = `bot-${id}`;

  // ---- combatant record: the same shape the player uses ----
  const position = new THREE.Vector3(opts.spawn.x, opts.spawn.y + halfTotal, opts.spawn.z);
  const eye = new THREE.Vector3(position.x, position.y - halfTotal + BOT.eyeHeight, position.z);
  const forward = new THREE.Vector3(0, 0, -1);

  const hitProxies = createBotHitProxies(rig);
  rig.root.add(hitProxies.root);

  const combatant: Combatant = {
    id,
    team,
    root: hitProxies.root,
    headMeshes: hitProxies.headMeshes,
    bodyMeshes: hitProxies.bodyMeshes,
    position,
    eye,
    bodyHandle: body.handle,
    health: COMBAT.maxHealth,
    alive: true,
    protection: 0,
    respawnIn: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
  };
  combat.add(combatant);

  // ---- weapon: the SAME factory the player's weapons come from ----
  const weapon: Weapon = createWeapon('rifle');

  // ---- state ----
  let state: BotState = 'Patrol';
  let preset = DIFFICULTY[opts.difficulty];
  let yaw = 0;
  const velocity = new THREE.Vector3();
  let path: THREE.Vector3[] = [];
  let pathIndex = 0;
  let pathGoal: THREE.Vector3 | null = null;
  let repathTimer = 0;
  let target: Combatant | null = null;
  let lastKnown: THREE.Vector3 | null = null;
  let memoryTimer = 0;
  let hasSight = false;
  let hadSight = false;
  let heard = false;
  let heardAt: THREE.Vector3 | null = null;
  let heardTimer = 0;

  /** Reaction delay countdown; > 0 means the bot has not earned its first shot. */
  let reactionTimer = 0;
  /** Seconds of continuous sight, which drives aim convergence. */
  let sightTime = 0;
  /** Current aim error half-angle, degrees. */
  let aimError = preset.initialError;
  let burstRemaining = 0;
  let burstPause = 0;

  // ---- tactics ----
  let strafeDir = Math.random() < 0.5 ? -1 : 1;
  let strafeTimer = 0;
  let cover: CoverSpot | null = null;
  /** Seconds to stay hidden once at cover, before peeking. */
  let coverHold = 0;
  /** Seconds of exposure while peeking, before ducking back. */
  let peekTimer = 0;
  let coverCooldown = 0;
  let crouching = false;
  let flankPoint: THREE.Vector3 | null = null;
  /** Seconds since the bot was last hit. */
  let sinceHit = 99;
  let threatFrom: THREE.Vector3 | null = null;
  let stuckTimer = 0;
  let stepPhase = 0;
  /** > 0 while rushing an enemy heard reloading. */
  let rushTimer = 0;
  /** > 0 while sidestepping out of a jam, along `unstickDir`. */
  let unstickTimer = 0;
  const unstickDir = new THREE.Vector3();
  /** The squad flank goal (and via-point) this bot has already reached. */
  let flankDone: THREE.Vector3 | null = null;
  let viaDone: THREE.Vector3 | null = null;
  /** Squad clock time this bot last saw its target with its own eyes. */
  let lastSawAt = -99;
  const squad = opts.squad;
  const S = BOT.squad;

  let perceptionTimer = Math.random() / BOT.perception.updateHz;
  const perceptionPeriod = 1 / BOT.perception.updateHz;

  /** Death animation progress, 0..1. Drives the fall on rigs without clips. */
  let deathProgress = 0;
  let lastHealth = combatant.health;

  // -------------------------------------------------------------------------
  // Raycasts
  // -------------------------------------------------------------------------

  /**
   * True when the straight line `from -> to` is blocked by level geometry or
   * cover. Characters are ignored (they are kinematic bodies): a teammate is
   * not a wall.
   */
  function worldBlocked(from: THREE.Vector3, to: THREE.Vector3, slack = 0.3): boolean {
    _rayDir.subVectors(to, from);
    const d = _rayDir.length();
    if (d < 1e-4) return false;
    _rayDir.divideScalar(d);
    const hit = physics.world.castRay(
      new RAPIER.Ray({ x: from.x, y: from.y, z: from.z }, { x: _rayDir.x, y: _rayDir.y, z: _rayDir.z }),
      d,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
      undefined,
      undefined,
      undefined,
      physics.blocksRays
    );
    return !!hit && hit.timeOfImpact < d - slack;
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  function canSee(other: Combatant): boolean {
    if (!other.alive || other.protection > 0) return false;

    _toTarget.subVectors(other.eye, eye);
    const distance = _toTarget.length();
    if (distance > BOT.perception.range) return false;
    if (distance < 1e-4) return true;
    _toTarget.divideScalar(distance);

    // ---- vision cone, in 3D ----
    // An enemy that shot this bot in the last moment is looked for in every
    // direction: being hit tells you where to look.
    if (sinceHit > 1.2) {
      const cosAngle = _toTarget.dot(forward);
      const cosLimit = Math.cos(THREE.MathUtils.degToRad(BOT.perception.fovDeg / 2));
      if (cosAngle < cosLimit) return false;
      if (Math.abs(_toTarget.y) > BOT.perception.cosTolerance) return false;
    }

    // ---- line of sight, to the chest ----
    // `castRay` reports `timeOfImpact` in units of the direction vector, so the
    // direction MUST be normalized. The aim point is inside the target's own
    // capsule, so the ray stops one radius short; 0.5 m of slack clears that and
    // is still far too small to see through a container wall.
    chestOf(other, _aimPoint);
    _rayDir.subVectors(_aimPoint, eye);
    const maxDist = _rayDir.length();
    if (maxDist < 1e-4) return true;
    _rayDir.divideScalar(maxDist);
    const hit = physics.world.castRay(
      new RAPIER.Ray({ x: eye.x, y: eye.y, z: eye.z }, { x: _rayDir.x, y: _rayDir.y, z: _rayDir.z }),
      maxDist,
      true,
      undefined,
      undefined,
      undefined,
      body,
      physics.blocksRays
    );
    return !hit || hit.timeOfImpact >= maxDist - 0.5;
  }

  function perceive() {
    const wasSeeing = hasSight;
    if (heardTimer > 0) {
      heardTimer -= perceptionPeriod;
      if (heardTimer <= 0) {
        heard = false;
        heardAt = null;
      }
    }

    let best: Combatant | null = null;
    let bestScore = Infinity;
    for (const other of combat.combatants) {
      if (other.team === team || !other.alive) continue;
      if (!canSee(other)) continue;
      // Prefer the current target (no flip-flopping), then the closest.
      const score = eye.distanceToSquared(other.position) * (other === target ? 0.6 : 1);
      if (score < bestScore) {
        bestScore = score;
        best = other;
      }
    }

    if (best) {
      if (best !== target) {
        reactionTimer = THREE.MathUtils.randFloat(preset.reactionMin, preset.reactionMax);
        sightTime = 0;
        aimError = preset.initialError;
        burstRemaining = 0;
        // Tell the team, and decide whether to fight this one from cover.
        opts.onSpotted?.(id, team, best.position);
        if (Math.random() < preset.coverUse) coverCooldown = 0;
        else coverCooldown = Math.max(coverCooldown, 2);
      } else if (!wasSeeing) {
        // Re-acquiring a target known by radio: pre-aimed, so quicker than a
        // cold reaction — but not instant, and aim has to settle again.
        reactionTimer = Math.max(
          reactionTimer,
          THREE.MathUtils.randFloat(preset.reactionMin, preset.reactionMax) * 0.6
        );
        sightTime *= 0.3;
      }
      reportSighting(squad, id, best);
      lastSawAt = squad.clock;
      target = best;
      hasSight = true;
      lastKnown = (lastKnown ?? new THREE.Vector3()).copy(best.position);
      memoryTimer = BOT.perception.memoryTime;
      flankPoint = null;
      return;
    }

    hasSight = false;

    // ---- radio: the squad knows where the target is even if we do not ----
    if (intelFresh(squad)) {
      const i = squad.intel!;
      if (target !== i.target) {
        target = i.target;
        reactionTimer = THREE.MathUtils.randFloat(preset.reactionMin, preset.reactionMax);
        sightTime = 0;
        aimError = preset.initialError;
      }
      lastKnown = predictedPosition(squad, lastKnown ?? new THREE.Vector3());
      memoryTimer = BOT.perception.memoryTime;
      return;
    }

    if (target) {
      if (!target.alive) {
        forgetTarget();
      } else {
        memoryTimer -= perceptionPeriod;
        if (memoryTimer <= 0) forgetTarget();
      }
    }
  }

  function forgetTarget() {
    target = null;
    lastKnown = null;
    memoryTimer = 0;
    flankPoint = null;
    releaseCover();
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  function repath(goal: THREE.Vector3) {
    const found = navmesh.path(feet(), goal);
    path = found.length ? found : [goal.clone()];
    pathIndex = 0;
    pathGoal = (pathGoal ?? new THREE.Vector3()).copy(goal);
    repathTimer = BOT.repathInterval;
  }

  /** Feet position, for navmesh queries. */
  function feet(): THREE.Vector3 {
    return _v3.set(position.x, position.y - halfTotal, position.z);
  }

  /**
   * Walks toward `goal` along the navmesh at `speed`. Repaths when the goal
   * moves or on a timer. Returns true when the goal is reached.
   */
  function moveTo(goal: THREE.Vector3, speed: number, dt: number, arriveRadius: number = BOT.waypointRadius): boolean {
    repathTimer -= dt;
    if (!pathGoal || pathGoal.distanceToSquared(goal) > 1 || repathTimer <= 0 || pathIndex >= path.length) {
      if (horizontalDistance(position, goal) < arriveRadius) {
        brake(dt);
        return true;
      }
      repath(goal);
    }
    while (pathIndex < path.length) {
      const wp = path[pathIndex];
      const last = pathIndex === path.length - 1;
      if (horizontalDistance(position, wp) < (last ? arriveRadius : BOT.waypointRadius)) {
        pathIndex++;
        continue;
      }
      _v1.subVectors(wp, position).setY(0).normalize();
      steer(_v1, speed, dt);
      return false;
    }
    brake(dt);
    return true;
  }

  function steer(dir: THREE.Vector3, speed: number, dt: number) {
    // Separation: bots spread out rather than stacking into one easy spray.
    // SIDEWAYS only — a push along the direction of travel had bots shoving
    // each other backwards and jamming every doorway-width gap.
    let px = 0;
    let pz = 0;
    for (const c of combat.combatants) {
      if (c === combatant || c.team !== team || !c.alive) continue;
      const dx = position.x - c.position.x;
      const dz = position.z - c.position.z;
      const d = Math.hypot(dx, dz);
      if (d < S.separation && d > 1e-3) {
        const w = ((S.separation - d) / S.separation) * 0.6;
        px += (dx / d) * w;
        pz += (dz / d) * w;
      }
    }
    // Right of way: meeting a teammate head-on, the higher id STEPS ASIDE for
    // the lower one. Merely stopping is not enough — a bot standing still in
    // the other's path is still in its path, and the two deadlock.
    if (unstickTimer > 0) {
      dir = _v2.copy(unstickDir);
    } else {
      for (const c of combat.combatants) {
        if (c === combatant || c.team !== team || !c.alive || c.id > id) continue;
        const dx = c.position.x - position.x;
        const dz = c.position.z - position.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.1 && d > 1e-3 && (dx * dir.x + dz * dir.z) / d > 0.3) {
          // Perpendicular to the line between us, on our own side of it.
          const s = dx * dir.z - dz * dir.x > 0 ? 1 : -1;
          unstickDir.set((-dz / d) * s, 0, (dx / d) * s);
          unstickTimer = 0.5;
          dir = _v2.copy(unstickDir);
          break;
        }
      }
    }
    const along = px * dir.x + pz * dir.z;
    let sx = dir.x + (px - along * dir.x);
    let sz = dir.z + (pz - along * dir.z);
    const len = Math.hypot(sx, sz) || 1;
    sx /= len;
    sz /= len;
    velocity.x = approach(velocity.x, sx * speed, BOT.accel * dt);
    velocity.z = approach(velocity.z, sz * speed, BOT.accel * dt);
  }

  function brake(dt: number) {
    velocity.x = approach(velocity.x, 0, BOT.accel * dt);
    velocity.z = approach(velocity.z, 0, BOT.accel * dt);
  }

  function turnToward(dir: THREE.Vector3, dt: number, fast = false) {
    if (dir.lengthSq() < 1e-6) return;
    const desiredYaw = Math.atan2(-dir.x, -dir.z);
    const rate = fast ? BOT.turnRateEngaged : BOT.turnRate;
    let delta = desiredYaw - yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const maxStep = rate * dt;
    yaw += THREE.MathUtils.clamp(delta, -maxStep, maxStep);
  }

  /** Faces a world point. */
  function lookAt(p: THREE.Vector3, dt: number, fast = true) {
    turnToward(_v2.subVectors(p, position).setY(0).normalize(), dt, fast);
  }

  /** Faces the direction of travel. */
  function faceTravel(dt: number) {
    if (velocity.x * velocity.x + velocity.z * velocity.z > 0.05) {
      turnToward(_v2.set(velocity.x, 0, velocity.z).normalize(), dt);
    }
  }

  function move(dt: number) {
    velocity.y += -22 * dt;
    if (velocity.y < -45) velocity.y = -45;

    const desired = _v2.set(velocity.x * dt, velocity.y * dt, velocity.z * dt);
    controller.computeColliderMovement(colliderHandle, { x: desired.x, y: desired.y, z: desired.z });
    const corrected = controller.computedMovement();
    const t = body.translation();
    const next = { x: t.x + corrected.x, y: t.y + corrected.y, z: t.z + corrected.z };
    body.setNextKinematicTranslation(next);

    if (controller.computedGrounded() && velocity.y < 0) velocity.y = 0;

    // ---- stuck detection: pushing but not getting anywhere ----
    const want = Math.hypot(desired.x, desired.z);
    const got = Math.hypot(corrected.x, corrected.z);
    if (want > 0.5 * dt && got < want * 0.25) stuckTimer += dt;
    else stuckTimer = Math.max(0, stuckTimer - dt);
    if (stuckTimer > 0.5) {
      // Pushing and going nowhere: step sideways for a moment (randomly left
      // or right, so two stuck bots do not mirror each other), then re-route.
      stuckTimer = 0;
      strafeDir = -strafeDir;
      const s = Math.random() < 0.5 ? -1 : 1;
      const len = Math.hypot(desired.x, desired.z) || 1;
      unstickDir.set((-desired.z / len) * s, 0, (desired.x / len) * s);
      unstickTimer = 0.6;
      path = [];
      pathGoal = null;
    }
    if (Math.abs(corrected.x - desired.x) > 1e-4) velocity.x *= 0.5;
    if (Math.abs(corrected.z - desired.z) > 1e-4) velocity.z *= 0.5;

    position.set(next.x, next.y, next.z);
  }

  // -------------------------------------------------------------------------
  // Aiming and firing
  // -------------------------------------------------------------------------

  function computeAimPoint(): THREE.Vector3 {
    const aimAt = _v3;
    if (target && hasSight) chestOf(target, aimAt);
    else if (lastKnown) aimAt.copy(lastKnown).setY(lastKnown.y + BOT.aim.aimHeight);
    else aimAt.copy(position).setY(position.y + BOT.aim.aimHeight);

    if (aimError > 1e-3) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * THREE.MathUtils.degToRad(aimError);
      const distance = eye.distanceTo(aimAt);
      const right = _v1.crossVectors(forward, UP).normalize();
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      const up = _v2.crossVectors(right, forward).normalize();
      aimAt
        .addScaledVector(right, Math.tan(radius) * Math.cos(angle) * distance)
        .addScaledVector(up, Math.tan(radius) * Math.sin(angle) * distance);
    }
    return aimAt;
  }

  /** True when a teammate stands close to the line of fire, nearer than the target. */
  function teammateInTheWay(aimAt: THREE.Vector3): boolean {
    const range = eye.distanceTo(aimAt);
    _aimDir.subVectors(aimAt, eye).normalize();
    for (const c of combat.combatants) {
      if (c === combatant || c.team !== team || !c.alive) continue;
      chestOf(c, _chest).sub(eye);
      const along = _chest.dot(_aimDir);
      if (along < 0 || along > range) continue;
      const off = Math.sqrt(Math.max(_chest.lengthSq() - along * along, 0));
      if (off < T.friendlyClearance) return true;
    }
    return false;
  }

  function fireOnce() {
    const origin = eye.clone();
    _aimPoint.copy(computeAimPoint());
    _aimDir.subVectors(_aimPoint, origin).normalize();

    const dir = weapon.tryFire(origin, _aimDir);
    if (!dir) {
      startReload();
      return;
    }

    const far = origin.clone().addScaledVector(dir, weapon.def.range);
    const hit = combat.fire(combatant, origin, far, weapon.def.damage, weapon.def.range);

    // Flash, tracer and sound start at the barrel, not the eye. Visual only:
    // the shot itself was traced from the eye above.
    const muzzle = rig.muzzleWorld?.(_muzzle) ? _muzzle : origin;
    effects.muzzleFlash(muzzle, dir);
    effects.tracer(muzzle, hit.point);
    effects.impact(hit);
    rig.animator?.fired();

    opts.onShot?.(id, muzzle.clone(), dir, hit);
  }

  function startReload() {
    if (weapon.reloading || weapon.ammo >= weapon.def.magazine) return;
    const empty = weapon.ammo <= 0;
    // The reload clip's length IS the reload time, so the magazine goes in when
    // the hands put it there.
    const clip = rig.animator?.reloadDuration;
    if (weapon.startReload(clip)) {
      opts.onReload?.(id, eye.clone(), clip ?? weapon.def.reloadTime, empty);
    }
  }

  /**
   * Burst fire control. Returns true while a burst is actively firing.
   *
   * `blind` is suppressive fire at the last known position: shorter bursts,
   * longer pauses, and no sight required.
   */
  function fireControl(dt: number, blind = false): boolean {
    if (reactionTimer > 0) {
      reactionTimer -= dt;
      return false;
    }
    if (!target) return false;
    if (!blind && !hasSight) return false;
    if (blind && !lastKnown) return false;
    if (burstPause > 0) {
      burstPause -= dt;
      return false;
    }
    if (burstRemaining <= 0) {
      burstRemaining = blind
        ? Math.round(THREE.MathUtils.randFloat(2, 4))
        : Math.round(THREE.MathUtils.randFloat(preset.burstMin, preset.burstMax));
    }
    // Hold fire rather than shoot a teammate in the back.
    if (blind) _aimPoint.copy(lastKnown!).setY(lastKnown!.y + BOT.aim.aimHeight);
    else chestOf(target, _aimPoint);
    if (teammateInTheWay(_aimPoint)) {
      burstPause = 0.25;
      strafeTimer = 0; // step aside for a clear line
      return false;
    }
    if (weapon.canFire()) {
      fireOnce();
      burstRemaining--;
      if (burstRemaining <= 0) {
        burstPause = blind
          ? THREE.MathUtils.randFloat(0.8, 1.7)
          : THREE.MathUtils.randFloat(BOT.burst.pauseMin, BOT.burst.pauseMax);
      }
    }
    return true;
  }

  /**
   * Suppressive fire on the spot the target was last seen, while flankers move.
   * Only when the shot would actually land near that spot — on the cover the
   * target is behind — never into a wall right in front of the bot.
   */
  function suppress(dt: number) {
    if (!lastKnown || !squad.intel) return;
    if (squad.clock - squad.intel.time > S.suppressWindow) return;
    _aimPoint.copy(lastKnown).setY(lastKnown.y + BOT.aim.aimHeight);
    const dist = eye.distanceTo(_aimPoint);
    if (dist > S.suppressRange || dist < 3) return;
    _aimDir.subVectors(_aimPoint, eye).divideScalar(dist);
    if (_aimDir.x * forward.x + _aimDir.z * forward.z < 0.95) return; // not facing it yet
    const hit = physics.world.castRay(
      new RAPIER.Ray({ x: eye.x, y: eye.y, z: eye.z }, { x: _aimDir.x, y: _aimDir.y, z: _aimDir.z }),
      dist,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
      undefined,
      undefined,
      undefined,
      physics.blocksRays
    );
    if (hit && hit.timeOfImpact < dist - S.suppressReach) return;
    aimError = Math.max(aimError, 3);
    fireControl(dt, true);
  }

  /** True when the target is aiming at this bot. */
  function beingAimedAt(): boolean {
    if (!target || !hasSight || !squad.aimOf) return false;
    const dir = squad.aimOf(target);
    if (!dir) return false;
    chestOf(combatant, _chest).sub(target.eye);
    const d = _chest.length();
    if (d < 1e-3) return false;
    return _chest.dot(dir) / d > Math.cos(THREE.MathUtils.degToRad(S.aimedAtDeg));
  }

  function updateAimError(dt: number) {
    if (hasSight) {
      sightTime += dt;
      const k = Math.min(sightTime / preset.tightenTime, 1);
      let converged = THREE.MathUtils.lerp(preset.initialError, preset.minError, k);
      // Moving costs accuracy in proportion to speed; crouching steadies it.
      const speed = Math.hypot(velocity.x, velocity.z);
      converged *= THREE.MathUtils.lerp(1, BOT.aim.movingScale, THREE.MathUtils.clamp((speed - 0.4) / 2.5, 0, 1));
      if (crouching) converged *= BOT.aim.crouchScale;
      aimError = converged;
    } else {
      aimError = Math.max(aimError, preset.minError);
    }
  }

  // -------------------------------------------------------------------------
  // Cover
  // -------------------------------------------------------------------------

  /** The threat cover must hide from: the target's eye, or where fire came from. */
  function threatEye(): THREE.Vector3 | null {
    if (target) return target.eye;
    return threatFrom;
  }

  /**
   * Picks the best cover spot against `threat`: close to this bot, on the far
   * side of its prop, not toward the threat, unclaimed, and — checked last
   * because it is a raycast — actually hidden from the threat's eye.
   */
  function findCover(threat: THREE.Vector3): CoverSpot | null {
    const myDist = horizontalDistance(position, threat);
    let best: CoverSpot | null = null;
    let bestScore = Infinity;
    const candidates: { spot: CoverSpot; score: number }[] = [];
    for (const spot of opts.coverSpots) {
      if (spot.claimedBy && spot.claimedBy !== id) continue;
      const d = horizontalDistance(position, spot.position);
      if (d > T.coverSearchRadius) continue;
      _v1.subVectors(threat, spot.position).setY(0);
      const toThreat = _v1.length();
      if (toThreat < T.coverMinThreatDistance) continue;
      _v1.divideScalar(toThreat);
      // The prop must be between the spot and the threat.
      if (spot.normal.dot(_v1) > -0.35) continue;
      // Do not run toward the enemy to get to cover.
      const score = d + Math.max(0, myDist - toThreat) * 2 + (spot.low ? 0 : 0.5);
      candidates.push({ spot, score });
    }
    candidates.sort((a, b) => a.score - b.score);
    for (const { spot, score } of candidates.slice(0, 6)) {
      const h = spot.low ? T.crouchEyeHeight : BOT.eyeHeight;
      _aimPoint.copy(spot.position).setY(spot.position.y + h);
      if (!worldBlocked(threat, _aimPoint)) continue;
      if (score < bestScore) {
        best = spot;
        bestScore = score;
      }
    }
    return best;
  }

  function claimCover(spot: CoverSpot) {
    releaseCover();
    cover = spot;
    spot.claimedBy = id;
    coverHold = THREE.MathUtils.randFloat(T.coverHoldMin, T.coverHoldMax);
    peekTimer = 0;
    state = 'TakeCover';
    path = [];
    pathGoal = null;
  }

  function releaseCover() {
    if (cover && cover.claimedBy === id) cover.claimedBy = null;
    cover = null;
    crouching = false;
  }

  /** True when the bot should break off and get to cover now. */
  function wantsCover(): boolean {
    if (coverCooldown > 0 || cover || rushTimer > 0) return false;
    const hurt = combatant.health < T.coverHealth && sinceHit < 2;
    const lowAmmo = weapon.ammo <= weapon.def.magazine * 0.2;
    const cautious = sightTime < 0.6 && coverCooldown <= 0;
    // Staring down the player's barrel while already hurt: get out of the open.
    const aimed = combatant.health < 80 && beingAimedAt();
    return hurt || lowAmmo || weapon.reloading || cautious || aimed;
  }

  // -------------------------------------------------------------------------
  // States
  // -------------------------------------------------------------------------

  function pickPatrolPoint() {
    // Searching as a squad: sweep this bot's own zone.
    // Every candidate must be on the floor and fully reachable: the navmesh
    // also covers container tops, and a bot sent to one waits there forever.
    const usable = (p: THREE.Vector3 | null): p is THREE.Vector3 =>
      !!p && p.y < 0.5 && reachable(navmesh, feet(), p);
    const zone = squad.roles.get(id) === 'search' ? squad.zones.get(id) : undefined;
    if (zone) {
      const centre = floorPoint(navmesh, zone, 3);
      const p = centre ? navmesh.randomPointAround(centre, 4) : null;
      if (usable(p)) {
        repath(p);
        return;
      }
    }
    // Patrol drifts toward the middle and the enemy's half of the hall — where
    // the fight is — rather than wandering in circles at home.
    const enemy = TEAM[enemyTeam].spawnCenter;
    const anchor = _v1
      .set(position.x, 0, position.z)
      .lerp(_v2.set(enemy.x * 0.5, 0, enemy.z * 0.5), 0.5);
    const point = navmesh.randomPointAround(anchor, BOT.patrol.wanderRadius);
    if (usable(point)) {
      repath(point);
    } else {
      const near = navmesh.nearestPoint(
        new THREE.Vector3(THREE.MathUtils.randFloatSpread(12), 0, THREE.MathUtils.randFloatSpread(30)),
        6
      );
      if (near) repath(near);
    }
  }

  /** A point to one side of `around`, approached from an angle. */
  function planFlank(around: THREE.Vector3): THREE.Vector3 | null {
    _v1.subVectors(around, position).setY(0).normalize();
    const side = Math.random() < 0.5 ? -1 : 1;
    for (const s of [side, -side]) {
      const perp = _v2.set(-_v1.z * s, 0, _v1.x * s);
      const p = around.clone().addScaledVector(perp, T.flankOffset).addScaledVector(_v1, -2).setY(0);
      // Any reachable side point will do: the route there is the flank.
      const snapped = floorPoint(navmesh, p, 3);
      if (snapped && reachable(navmesh, feet(), snapped)) return snapped.clone();
    }
    return null;
  }

  function stateTakeCover(dt: number) {
    state = 'TakeCover';
    const spot = cover!;
    const arrived = moveTo(spot.position, BOT.sprintSpeed, dt, 0.45);
    if (!arrived) {
      // Run to cover facing the route; turn to the threat for the last metres.
      crouching = false;
      if (horizontalDistance(position, spot.position) < 2.5 && threatEye()) lookAt(threatEye()!, dt);
      else faceTravel(dt);
      if (hasSight) fireControl(dt); // suppressive fire on the way
      return;
    }

    // At cover: hide, reload, wait.
    brake(dt);
    crouching = spot.low;
    if (threatEye()) lookAt(threatEye()!, dt);
    if (weapon.ammo < weapon.def.magazine * T.tacticalReloadFraction) startReload();
    if (weapon.reloading) return;

    // A tall prop can be compromised by an enemy walking round it; a low one
    // when we are standing. If we can be seen, shoot back.
    if (hasSight && !crouching) {
      fireControl(dt);
    }
    coverHold -= dt;
    if (coverHold <= 0) {
      // Peek: stand up (low cover) or step out (tall cover) into Engage.
      crouching = false;
      peekTimer = THREE.MathUtils.randFloat(T.peekMin, T.peekMax);
      coverHold = THREE.MathUtils.randFloat(T.coverHoldMin, T.coverHoldMax);
      state = 'Engage';
    }
  }

  function stateEngageVisible(dt: number) {
    state = 'Engage';
    const t = target!;
    lookAt(t.position, dt);

    const firing = fireControl(dt);

    // ---- peeking from cover: duck back after a few seconds of exposure ----
    if (cover) {
      peekTimer -= dt;
      const atSpot = horizontalDistance(position, cover.position) < 1.2;
      if (peekTimer <= 0 || (combatant.health < T.coverHealth && sinceHit < 0.5)) {
        stateTakeCover(dt);
        return;
      }
      if (cover.low && atSpot) {
        // Pop up over a crate: stand still and shoot.
        brake(dt);
        return;
      }
    }

    // ---- strafe: move between bursts, plant the feet to shoot ----
    // Being aimed at makes the strafe faster and less predictable.
    const aimed = beingAimedAt();
    strafeTimer -= dt * (aimed ? 2 : 1);
    if (strafeTimer <= 0) {
      strafeTimer = THREE.MathUtils.randFloat(T.strafeSwitchMin, T.strafeSwitchMax);
      if (Math.random() < 0.7) strafeDir = -strafeDir;
    }
    _v1.subVectors(t.position, position).setY(0);
    const dist = _v1.length();
    _v1.divideScalar(Math.max(dist, 1e-3));
    const side = _v2.set(-_v1.z * strafeDir, 0, _v1.x * strafeDir);
    // Keep a sensible distance: close in from far away, back off when too close.
    // Rushing a reloading enemy closes the distance regardless.
    const rangeBias = rushTimer > 0 ? 1.2 : dist > T.rangeMax ? 0.8 : dist < T.rangeMin ? -0.8 : 0;
    side.addScaledVector(_v1, rangeBias).normalize();

    // Do not strafe off the navmesh or into a wall.
    const probe = feet().clone().addScaledVector(side, 1.2);
    if (!navmesh.isWalkable(probe, 0.5)) {
      strafeDir = -strafeDir;
      strafeTimer = THREE.MathUtils.randFloat(T.strafeSwitchMin, T.strafeSwitchMax);
      brake(dt);
      return;
    }
    let speed = firing ? T.strafeSpeed * 0.3 : T.strafeSpeed;
    if (aimed && !firing) speed *= 1.35;
    if (rushTimer > 0) speed = BOT.sprintSpeed * 0.8;
    steer(side, speed, dt);
  }

  /** Hold the angle on the target's last position and suppress it. */
  function statePin(dt: number) {
    state = 'Engage';
    brake(dt);
    crouching = false;
    lookAt(lastKnown!, dt);
    suppress(dt);
  }

  /**
   * Swing round to this bot's assigned side of the target, then push in.
   * "Reached" is whatever `moveTo` says — as close as the navmesh allows — so a
   * goal that turns out to be unreachable cannot pin a bot in place.
   */
  function stateSquadFlank(dt: number, goal: THREE.Vector3) {
    state = 'Flank';
    // Out to the side lane first, if the plan has one.
    const via = squad.vias.get(id);
    if (via && via !== viaDone) {
      if (moveTo(via, BOT.sprintSpeed, dt, 1.5)) viaDone = via;
      faceTravel(dt);
      return;
    }
    if (goal !== flankDone) {
      // Sprint the route; slow to a walk and pre-aim only in the last metres.
      const close = !!lastKnown && horizontalDistance(position, lastKnown) < S.flankSlowRange;
      const arrived = moveTo(goal, close ? T.pushSpeed : BOT.sprintSpeed, dt, 1.2);
      if (close) lookAt(lastKnown!, dt);
      else faceTravel(dt);
      if (!arrived) return;
      flankDone = goal;
    }
    statePush(dt);
  }

  /** The enemy is reloading: close the distance now. */
  function stateRush(dt: number) {
    state = 'Engage';
    moveTo(lastKnown!, BOT.sprintSpeed, dt, 1.5);
    if (horizontalDistance(position, lastKnown!) < T.preAimRange) lookAt(lastKnown!, dt);
    else faceTravel(dt);
  }

  function statePush(dt: number) {
    // Lost sight: approach the last known position at a walk, weapon up.
    state = 'Engage';
    const goal = lastKnown!;
    const arrived = moveTo(goal, T.pushSpeed, dt, 1.2);
    if (horizontalDistance(position, goal) < T.preAimRange) lookAt(goal, dt);
    else faceTravel(dt);
    if (arrived) {
      // Nothing there. Look around, then give up.
      memoryTimer = Math.min(memoryTimer, 1);
      yaw += dt * 1.5;
    }
  }

  function stateFlank(dt: number) {
    state = 'Flank';
    const arrived = moveTo(flankPoint!, BOT.sprintSpeed, dt, 1);
    if (lastKnown && horizontalDistance(position, lastKnown) < T.preAimRange) lookAt(lastKnown, dt);
    else faceTravel(dt);
    if (arrived) flankPoint = null; // now push the last known position
  }

  function stateRetreat(dt: number) {
    state = 'Retreat';
    const t = target!;
    _v1.subVectors(position, t.position).setY(0).normalize();
    const goal = feet().clone().addScaledVector(_v1, 6);
    const snapped = floorPoint(navmesh, goal, 3) ?? goal;
    moveTo(snapped, T.strafeSpeed, dt, 1);
    lookAt(t.position, dt);
    fireControl(dt);
  }

  function updateState(dt: number) {
    // ---- death ----
    if (!combatant.alive) {
      state = 'Dead';
      releaseCover();
      deathProgress = Math.min(1, deathProgress + dt / BOT.death.fallTime);
      return;
    }
    if (state === 'Dead') {
      // Respawned.
      state = 'Patrol';
      deathProgress = 0;
      path = [];
      pathIndex = 0;
      pathGoal = null;
      forgetTarget();
      heard = false;
      heardAt = null;
      reactionTimer = 0;
      sightTime = 0;
      aimError = preset.initialError;
      burstRemaining = 0;
      burstPause = 0;
      sinceHit = 99;
      threatFrom = null;
      pickPatrolPoint();
      return;
    }

    coverCooldown = Math.max(0, coverCooldown - dt);
    sinceHit += dt;
    rushTimer = Math.max(0, rushTimer - dt);
    unstickTimer = Math.max(0, unstickTimer - dt);
    updateAimError(dt);

    // Sight just lost: flank or push? Only for a bot fighting alone — a squad
    // plans its flanks together (see assignRoles).
    const alone = squad.roles.size <= 1;
    if (alone && hadSight && !hasSight && target && !flankPoint && lastKnown && !cover) {
      if (Math.random() < preset.flankChance) flankPoint = planFlank(lastKnown);
    }
    hadSight = hasSight;

    // ---- under threat: cover, retreat ----
    const threat = threatEye();
    if (threat && (hasSight || sinceHit < 1.5) && wantsCover()) {
      const spot = findCover(threat);
      if (spot) claimCover(spot);
      else coverCooldown = 1.5; // nothing suitable; do not search every frame
    }
    if (cover && !target && sinceHit > 3) releaseCover();

    // ---- reload: at cover if there is one ----
    if (weapon.reloading) {
      if (cover) {
        stateTakeCover(dt);
      } else {
        state = 'Reload';
        if (target && hasSight && combatant.health < T.retreatHealth) {
          // Back away while the magazine goes in.
          _v1.subVectors(position, target.position).setY(0).normalize();
          steer(_v1, T.strafeSpeed * 0.7, dt);
        } else {
          brake(dt);
        }
        if (target) lookAt(target.position, dt);
      }
      return;
    }

    if (target && hasSight) {
      if (cover && state === 'TakeCover') {
        stateTakeCover(dt);
      } else if (!cover && combatant.health < T.retreatHealth && sinceHit < 2) {
        stateRetreat(dt);
      } else {
        stateEngageVisible(dt);
      }
      return;
    }

    if (target && memoryTimer > 0 && lastKnown) {
      // Cover is for pinning. A flanker leaves it to do its job, unless it is
      // hurt or reloading.
      const flanking = squad.roles.get(id) === 'flank' && squad.goals.has(id);
      if (cover && flanking && combatant.health >= T.coverHealth && !weapon.reloading) releaseCover();
      if (cover) {
        // Running to cover breaks line of sight by design; keep going.
        if (state === 'TakeCover') {
          stateTakeCover(dt);
          return;
        }
        // Peeked and saw nothing: hold the peek a moment, then move on.
        peekTimer -= dt;
        if (peekTimer > 0) {
          state = 'Engage';
          crouching = false;
          brake(dt);
          lookAt(lastKnown, dt);
          return;
        }
        releaseCover();
      }
      // Top up between fights.
      if (weapon.ammo < weapon.def.magazine * T.tacticalReloadFraction) startReload();
      if (rushTimer > 0) {
        stateRush(dt);
        return;
      }
      const role = squad.roles.get(id);
      const goal = squad.goals.get(id);
      if (role === 'flank' && goal) {
        stateSquadFlank(dt, goal);
        return;
      }
      // Pinner: hold and suppress while the flankers move in — if it can see
      // the spot. A pinner with no line of sight is no use standing still: it
      // advances until it has one. Everyone pushes once the trail goes cold.
      const age = squad.intel ? squad.clock - squad.intel.time : Infinity;
      if (!alone && age < S.holdTime && squad.clock - lastSawAt < 1.5) {
        statePin(dt);
        return;
      }
      if (flankPoint) stateFlank(dt);
      else statePush(dt);
      return;
    }

    // ---- no enemy in mind ----
    crouching = false;
    if (weapon.ammo < weapon.def.magazine * T.tacticalReloadFraction) startReload();

    if (heard && heardAt) {
      state = 'Patrol';
      const arrived = moveTo(heardAt, T.pushSpeed, dt, 1.5);
      if (horizontalDistance(position, heardAt) < T.preAimRange) lookAt(heardAt, dt, false);
      else faceTravel(dt);
      if (arrived) {
        heard = false;
        heardAt = null;
      }
      return;
    }

    state = 'Patrol';
    const searching = squad.roles.get(id) === 'search';
    if (pathIndex >= path.length) pickPatrolPoint();
    if (pathGoal && moveTo(pathGoal, searching ? T.pushSpeed : BOT.walkSpeed, dt)) {
      repathTimer -= dt;
      if (repathTimer <= -THREE.MathUtils.randFloat(BOT.patrol.idleMin, BOT.patrol.idleMax)) pickPatrolPoint();
    }
    faceTravel(dt);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  function update(dt: number) {
    perceptionTimer -= dt;
    if (perceptionTimer <= 0) {
      perceptionTimer += perceptionPeriod;
      if (perceptionTimer <= 0) perceptionTimer = perceptionPeriod;
      if (combatant.alive) perceive();
    }

    updateState(dt);
    move(dt);

    // ---- publish pose ----
    forward.set(0, 0, -1).applyAxisAngle(UP, yaw);
    const eyeHeight = crouching ? T.crouchEyeHeight : BOT.eyeHeight;
    eye.set(position.x, position.y - halfTotal + eyeHeight, position.z);

    rig.root.position.set(position.x, position.y - halfTotal, position.z);
    rig.root.rotation.y = yaw;

    // ---- footsteps ----
    const speed = Math.hypot(velocity.x, velocity.z);
    if (combatant.alive && speed > 0.5) {
      stepPhase += stepsPerSecond(speed) * dt;
      if (stepPhase >= 1) {
        stepPhase -= 1;
        const intensity = THREE.MathUtils.clamp(speed / BOT.sprintSpeed, 0.2, 1) * (crouching ? 0.4 : 1);
        opts.onFootstep?.(id, feet().clone(), intensity);
      }
    }

    if (rig.animator) {
      if (combatant.alive && combatant.health < lastHealth) {
        rig.animator.flinch((lastHealth - combatant.health) / 35);
      }
      let aimPitch = 0;
      if (target && hasSight) {
        chestOf(target, _v1).sub(eye);
        aimPitch = Math.atan2(_v1.y, Math.hypot(_v1.x, _v1.z));
      }
      rig.animator.update(dt, {
        velocity,
        yaw,
        aiming: (state === 'Engage' || state === 'Retreat' || state === 'TakeCover') && hasSight,
        aimPitch,
        reloading: weapon.reloading,
        crouching,
        dead: state === 'Dead',
      });
    } else {
      if (state === 'Dead') {
        const e = easeOutCubic(deathProgress);
        rig.root.rotation.x = THREE.MathUtils.degToRad(BOT.death.fallAngle) * e;
        rig.root.position.y -= 0.35 * e;
      } else {
        rig.root.rotation.x = 0;
      }
      rig.root.updateMatrixWorld(true);
    }
    lastHealth = combatant.health;

    weapon.update(dt, { speed, crouching, aiming: false });
  }

  /**
   * Investigate a sound, if nothing more pressing is going on.
   *
   * The bot remembers the sound for as long as it takes to WALK there, plus
   * `seconds` to look around on arrival. A fixed memory made a far sound
   * pointless: at push speed 4 s covers under 10 m, so the bot gave up halfway
   * and never reached the shooter. Every repeat of the sound (each shot of a
   * burst) refreshes the position, so the bot homes in on a moving shooter.
   */
  function investigate(at: THREE.Vector3, seconds: number) {
    if (!combatant.alive || (target && hasSight)) return;
    heard = true;
    // Sounds arrive at the source's height — a gunshot at eye level, 1.7 m up.
    // The navmesh cannot route to a point in mid-air, and the straight-line
    // fallback walks the bot into the first container, so snap to the floor.
    _v2.set(at.x, 0, at.z);
    heardAt = (heardAt ?? new THREE.Vector3()).copy(floorPoint(navmesh, _v2, 3) ?? _v2);
    const travel = horizontalDistance(position, at) / T.pushSpeed;
    heardTimer = Math.max(heardTimer, Math.min(travel, T.maxInvestigateTravel) + seconds);
  }

  return {
    id,
    team,
    get state() {
      return state;
    },
    combatant,
    get position() {
      return position;
    },
    get eye() {
      return eye;
    },
    get forward() {
      return forward;
    },
    get path() {
      return path;
    },
    velocity,
    weapon,
    get target() {
      return target;
    },
    get lastKnown() {
      return lastKnown;
    },
    get hasSight() {
      return hasSight;
    },
    get heard() {
      return heard;
    },
    get crouching() {
      return crouching;
    },
    rig,
    setDifficulty(d) {
      preset = DIFFICULTY[d];
    },
    teleport(to) {
      position.set(to.x, to.y + halfTotal, to.z);
      velocity.set(0, 0, 0);
      body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
      path = [];
      pathIndex = 0;
      pathGoal = null;
      repathTimer = 0;
      releaseCover();
      yaw = to.z < 0 ? Math.PI : 0;
      rig.root.rotation.x = 0;
      deathProgress = 0;
      lastHealth = combatant.health;
      rig.animator?.reset();
    },
    hearGunshot(at) {
      if (eye.distanceTo(at) > BOT.perception.hearRadius) return;
      investigate(at, 4);
    },
    hearNoise(at, radius) {
      if (eye.distanceTo(at) > radius) return;
      investigate(at, 3);
    },
    hearEnemyReload(at, duration) {
      if (!combatant.alive || eye.distanceTo(at) > S.reloadHearRadius) return;
      investigate(at, 4);
      // Rush only when healthy enough to survive the push.
      if (combatant.health > T.retreatHealth) {
        rushTimer = duration * 0.9;
        releaseCover();
      }
    },
    hearCallout(at) {
      if (eye.distanceTo(at) > T.calloutRadius) return;
      investigate(at, 5);
    },
    notifyDamaged(attacker) {
      sinceHit = 0;
      if (!attacker) return;
      threatFrom = (threatFrom ?? new THREE.Vector3()).copy(attacker.eye);
      // Shot by someone unseen: go and find them. For the next moment the
      // vision cone is ignored (see `canSee`), so if they are in line of sight
      // the bot "turns round" and acquires them on its next perception tick.
      if (!target || !hasSight) investigate(attacker.position, 4);
    },
    update,
    dispose() {
      releaseCover();
      physics.world.removeCharacterController(controller);
      physics.world.removeRigidBody(body);
      combat.remove(id);
      rig.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Hit proxies
// ---------------------------------------------------------------------------

/**
 * Head and body hit proxies, parented to the rig's bones so they follow the
 * animation — a bot that is crouched or mid-fall has its head where its head
 * actually is.
 *
 * The materials are invisible rather than the objects: the renderer skips a mesh
 * whose material is invisible, while the raycaster still sees it.
 */
function createBotHitProxies(rig: CharacterRig) {
  const root = new THREE.Group();
  root.name = 'bot-hitbox';

  const headMat = new THREE.MeshBasicMaterial();
  headMat.visible = false;
  const bodyMat = new THREE.MeshBasicMaterial();
  bodyMat.visible = false;

  // Each proxy is positioned in WORLD space against the rest pose and then
  // `attach()`ed to its bone, which keeps its world size and offset. Setting a
  // local offset instead would inherit the bone's scale — on an imported rig
  // that can be 0.002, and the head hitbox would shrink to a pinhead.
  rig.root.updateMatrixWorld(true);
  const place = (mesh: THREE.Mesh, bone: THREE.Object3D | undefined, lift: number) => {
    if (!bone) {
      root.add(mesh);
      return;
    }
    bone.getWorldPosition(mesh.position);
    mesh.position.y += lift;
    rig.root.worldToLocal(mesh.position);
    rig.root.add(mesh);
    mesh.updateMatrixWorld(true);
    bone.attach(mesh);
  };

  const headGeo = new THREE.SphereGeometry(0.14, 10, 8);
  const head = new THREE.Mesh(headGeo, headMat);
  head.name = 'bot-hitbox-head';
  // The head bone sits at the base of the skull; the sphere is centred above it.
  place(head, rig.headBone ?? rig.bones.Head, 0.1);

  // The torso runs from just below the hips to the base of the neck, and must
  // STOP there: combat takes the first proxy along the ray, so a torso capsule
  // that reaches over the head swallows every headshot.
  const spine = rig.bones.Spine1 ?? rig.bones.Spine;
  const hips = rig.bones.Hips;
  const neck = rig.bones.Neck ?? rig.headBone;
  const radius = 0.24;
  let length = 0.6;
  let lift = 0.15;
  if (spine && hips && neck) {
    const bottom = hips.getWorldPosition(new THREE.Vector3()).y - 0.12;
    const top = neck.getWorldPosition(new THREE.Vector3()).y;
    length = Math.max(top - bottom - radius * 2, 0.1);
    lift = (top + bottom) / 2 - spine.getWorldPosition(new THREE.Vector3()).y;
  }
  const bodyGeo = new THREE.CapsuleGeometry(radius, length, 4, 10);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.name = 'bot-hitbox-body';
  place(body, spine, lift);

  return {
    root,
    headMeshes: [head],
    bodyMeshes: [body],
  };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface BotManagerOptions extends BotCallbacks {
  physics: Physics;
  combat: Combat;
  navmesh: NavMeshSystem;
  effects: Effects;
  soldier: SoldierSource | null;
  rifle: RifleAsset | null;
  difficulty: Difficulty;
  /** Cover props, from which cover spots are generated. */
  coverProps: CoverProp[];
  /** Where a combatant is aiming, if the game knows (the player's camera). */
  aimOf?: (c: Combatant) => THREE.Vector3 | null;
}

export function createBotManager(opts: BotManagerOptions): BotManager {
  const bots: Bot[] = [];
  const squads = new Map<TeamId, Squad>();
  let roleTimer = 0;
  const squadOf = (team: TeamId) => {
    let s = squads.get(team);
    if (!s) squads.set(team, (s = createSquad(team, opts.aimOf)));
    return s;
  };
  const coverSpots = buildCoverSpots(opts.coverProps, opts.navmesh);
  console.log(
    `[bots] ${coverSpots.length} cover spots (${coverSpots.filter((s) => s.low).length} low, crouch-behind)`
  );

  return {
    bots,
    squads,
    get combatants() {
      return bots.map((b) => b.combatant);
    },

    spawn(id, team, spawn) {
      const bot = createBot({
        id,
        team,
        spawn,
        physics: opts.physics,
        combat: opts.combat,
        navmesh: opts.navmesh,
        effects: opts.effects,
        soldier: opts.soldier,
        rifle: opts.rifle,
        difficulty: opts.difficulty,
        coverSpots,
        squad: squadOf(team),
        onShot: opts.onShot,
        onFootstep: opts.onFootstep,
        onReload: opts.onReload,
        onSpotted(fromId, fromTeam, at) {
          // Callout: teammates in earshot come and help.
          for (const b of bots) {
            if (b.id !== fromId && b.team === fromTeam) b.hearCallout(at);
          }
        },
      });
      bots.push(bot);
      return bot;
    },

    broadcastGunshot(at, shooterId) {
      for (const bot of bots) {
        if (bot.id === shooterId) continue;
        bot.hearGunshot(at);
      }
    },

    broadcastNoise(at, sourceTeam, radius) {
      for (const bot of bots) {
        if (bot.team !== sourceTeam) bot.hearNoise(at, radius);
      }
    },

    notifyDamaged(targetId, attacker) {
      bots.find((b) => b.id === targetId)?.notifyDamaged(attacker);
    },

    broadcastReload(at, sourceTeam, duration) {
      for (const bot of bots) {
        if (bot.team !== sourceTeam) bot.hearEnemyReload(at, duration);
      }
    },

    setDifficulty(d) {
      for (const bot of bots) bot.setDifficulty(d);
    },

    update(dt) {
      for (const s of squads.values()) s.clock += dt;
      roleTimer -= dt;
      if (roleTimer <= 0) {
        roleTimer = BOT.squad.roleInterval;
        for (const [team, s] of squads) {
          assignRoles(s, bots.filter((b) => b.team === team), opts.navmesh);
        }
      }
      for (const bot of bots) bot.update(dt);
    },

    dispose() {
      for (const bot of bots) bot.dispose();
      bots.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

function horizontalDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function easeOutCubic(t: number): number {
  const c = THREE.MathUtils.clamp(t, 0, 1);
  return 1 - Math.pow(1 - c, 3);
}

export { RIFLE, SPAWN };
