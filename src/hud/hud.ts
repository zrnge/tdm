/**
 * HTML/CSS HUD overlay.
 *
 * The brief puts the HUD in the DOM rather than in the 3D scene, which is the
 * right call: text stays crisp at any resolution, CSS handles the layout, and
 * nothing here costs a draw call.
 *
 * Phase 2 scope: crosshair (spread-reactive), health bar, ammo, team score,
 * kill feed, hit marker, damage-direction indicator, scoreboard on Tab.
 * The minimap and menu screens arrive in Phase 5.
 */
import { TEAM, type TeamId } from '../config';
import type { Settings } from '../game/settings';

export interface HudTeamState {
  kills: number;
  name: string;
  accent: string;
}

export interface HudState {
  health: number;
  maxHealth: number;
  ammo: number;
  magazine: number;
  weaponName: string;
  reloading: boolean;
  reloadProgress: number;
  /** Current spread half-angle in degrees; drives the crosshair gap. */
  spread: number;
  /** 0..1, how far into ADS the player is. */
  ads: number;
  /** Seconds of spawn protection remaining, or 0. */
  protection: number;
  /** Seconds until respawn, or 0 when alive. */
  respawnIn: number;
  /** Team scores, keyed by team. */
  teams: Record<TeamId, HudTeamState>;
  /** Time remaining in the match, seconds. */
  timeRemaining: number;
}

export interface ScoreRow {
  name: string;
  team: TeamId;
  kills: number;
  deaths: number;
  assists: number;
  isPlayer: boolean;
}

export interface Hud {
  /** Pushes a full state snapshot. Cheap; call once per frame. */
  update(state: HudState, dt: number): void;
  /** Adds a line to the kill feed. */
  addKill(killer: string, killerTeam: TeamId, victim: string, victimTeam: TeamId, headshot: boolean): void;
  /** Flashes the hit marker. `headshot` makes it red. */
  hitMarker(headshot: boolean, killed: boolean): void;
  /** Points the damage indicator toward the attacker, in radians (0 = ahead). */
  damageFrom(angle: number): void;
  /** Shows or hides the scoreboard. */
  setScoreboard(visible: boolean, rows: ScoreRow[]): void;
  dispose(): void;
}

export function createHud(settings: Settings): Hud {
  const root = document.getElementById('hud')!;
  root.innerHTML = '';

  // ---------------------------------------------------------------- crosshair
  const crosshair = el('div', 'hud-crosshair');
  const chTop = el('div', 'hud-crosshair__tick hud-crosshair__tick--top');
  const chBottom = el('div', 'hud-crosshair__tick hud-crosshair__tick--bottom');
  const chLeft = el('div', 'hud-crosshair__tick hud-crosshair__tick--left');
  const chRight = el('div', 'hud-crosshair__tick hud-crosshair__tick--right');
  const chDot = el('div', 'hud-crosshair__dot');
  crosshair.append(chTop, chBottom, chLeft, chRight, chDot);
  root.appendChild(crosshair);

  // ---------------------------------------------------------------- hit marker
  const hitMark = el('div', 'hud-hitmarker');
  for (const cls of ['tl', 'tr', 'bl', 'br']) {
    hitMark.appendChild(el('div', `hud-hitmarker__arm hud-hitmarker__arm--${cls}`));
  }
  root.appendChild(hitMark);

  // ------------------------------------------------------- damage direction
  const damageArc = el('div', 'hud-damage');
  damageArc.appendChild(el('div', 'hud-damage__arc'));
  root.appendChild(damageArc);

  // ---------------------------------------------------------------- top bar
  const topBar = el('div', 'hud-top');

  const blueScore = el('div', 'hud-score hud-score--blue');
  const blueName = el('span', 'hud-score__name');
  const blueValue = el('span', 'hud-score__value');
  blueScore.append(blueName, blueValue);

  const timer = el('div', 'hud-timer');

  const redScore = el('div', 'hud-score hud-score--red');
  const redName = el('span', 'hud-score__name');
  const redValue = el('span', 'hud-score__value');
  redScore.append(redName, redValue);

  topBar.append(blueScore, timer, redScore);
  root.appendChild(topBar);

  // ---------------------------------------------------------------- kill feed
  const killFeed = el('div', 'hud-killfeed');
  root.appendChild(killFeed);

  // ---------------------------------------------------------------- bottom left
  const healthBox = el('div', 'hud-health');
  const healthBar = el('div', 'hud-health__bar');
  const healthFill = el('div', 'hud-health__fill');
  const healthText = el('span', 'hud-health__text');
  healthBar.appendChild(healthFill);
  healthBox.append(healthBar, healthText);
  root.appendChild(healthBox);

  // --------------------------------------------------------------- bottom right
  const ammoBox = el('div', 'hud-ammo');
  const weaponName = el('div', 'hud-ammo__weapon');
  const ammoText = el('div', 'hud-ammo__count');
  const reloadBar = el('div', 'hud-ammo__reload');
  const reloadFill = el('div', 'hud-ammo__reload-fill');
  reloadBar.appendChild(reloadFill);
  ammoBox.append(weaponName, ammoText, reloadBar);
  root.appendChild(ammoBox);

  // --------------------------------------------------------------- centre text
  const centre = el('div', 'hud-centre');
  root.appendChild(centre);

  // ---------------------------------------------------------------- scoreboard
  const scoreboard = el('div', 'hud-scoreboard');
  const sbTitle = el('div', 'hud-scoreboard__title');
  const sbBody = el('div', 'hud-scoreboard__body');
  scoreboard.append(sbTitle, sbBody);
  scoreboard.style.display = 'none';
  root.appendChild(scoreboard);

  // ------------------------------------------------------------------ state
  let hitTimer = 0;
  let damageTimer = 0;
  let damageAngle = 0;
  let lastRespawnShown = 0;

  function update(state: HudState) {
    // ---- crosshair: gap grows with spread, and the whole thing gives way to
    //      the iron sights while aiming ----
    const gap = 5 + state.spread * 3.2;
    const len = 7 - state.ads * 2;
    chTop.style.transform = `translate(-50%, ${-gap - len}px)`;
    chBottom.style.transform = `translate(-50%, ${gap}px)`;
    chLeft.style.transform = `translate(${-gap - len}px, -50%)`;
    chRight.style.transform = `translate(${gap}px, -50%)`;
    for (const tick of [chTop, chBottom]) tick.style.height = `${len}px`;
    for (const tick of [chLeft, chRight]) tick.style.width = `${len}px`;

    // The crosshair is HIDDEN while aiming, not merely faded: the iron sights are
    // the aiming reference, and floating ticks around them read as clutter. It
    // fades out over the last part of the ADS blend so the transition is smooth,
    // and is gone by the time the sights are up.
    crosshair.style.opacity = String(1 - smoothstep(0.35, 0.85, state.ads));

    // The centre dot replaces it, and only when the player has asked for it.
    // 3 px, at the exact screen centre — which is where the front sight post is
    // solved to sit, so the two agree.
    chDot.style.opacity = String(settings.values.adsCenterDot ? smoothstep(0.5, 0.95, state.ads) : 0);

    // ---- health ----
    const hp = Math.max(0, Math.round(state.health));
    const frac = Math.max(0, Math.min(1, state.health / state.maxHealth));
    healthFill.style.width = `${frac * 100}%`;
    healthFill.style.background =
      frac > 0.6 ? '#4ade80' : frac > 0.3 ? '#fbbf24' : '#ef4444';
    healthText.textContent = `${hp}`;
    healthBox.style.opacity = state.respawnIn > 0 ? '0.35' : '1';

    // ---- ammo ----
    weaponName.textContent = state.weaponName;
    ammoText.textContent = `${state.ammo} / ${state.magazine}`;
    ammoText.classList.toggle('hud-ammo__count--low', state.ammo <= state.magazine * 0.25);
    reloadBar.style.display = state.reloading ? 'block' : 'none';
    reloadFill.style.width = `${state.reloadProgress * 100}%`;

    // ---- scores ----
    blueName.textContent = state.teams.blue.name;
    blueValue.textContent = `${state.teams.blue.kills}`;
    redName.textContent = state.teams.red.name;
    redValue.textContent = `${state.teams.red.kills}`;

    const total = Math.max(0, Math.floor(state.timeRemaining));
    const mm = Math.floor(total / 60);
    const ss = total % 60;
    timer.textContent = `${mm}:${String(ss).padStart(2, '0')}`;

    // ---- centre messages ----
    if (state.respawnIn > 0) {
      centre.textContent = `RESPAWN IN ${state.respawnIn.toFixed(1)}`;
      centre.style.display = 'block';
      lastRespawnShown = state.respawnIn;
    } else if (state.protection > 0) {
      centre.textContent = 'SPAWN PROTECTION';
      centre.style.display = 'block';
      lastRespawnShown = 0;
    } else if (lastRespawnShown > 0) {
      centre.style.display = 'none';
      lastRespawnShown = 0;
    } else {
      centre.style.display = 'none';
    }
  }

  function addKill(
    killer: string,
    killerTeam: TeamId,
    victim: string,
    victimTeam: TeamId,
    headshot: boolean
  ) {
    const line = el('div', 'hud-killfeed__line');
    const k = el('span', `hud-killfeed__name hud-killfeed__name--${killerTeam}`);
    k.textContent = killer;
    const verb = el('span', 'hud-killfeed__verb');
    verb.textContent = headshot ? '⌖' : '✕';
    const v = el('span', `hud-killfeed__name hud-killfeed__name--${victimTeam}`);
    v.textContent = victim;
    line.append(k, verb, v);
    killFeed.appendChild(line);

    // Fade out and remove. Cap the feed so a long match cannot grow the DOM
    // without bound.
    while (killFeed.childElementCount > 5) killFeed.firstElementChild?.remove();
    setTimeout(() => {
      line.classList.add('hud-killfeed__line--out');
      setTimeout(() => line.remove(), 400);
    }, 5200);
  }

  function hitMarker(headshot: boolean, killed: boolean) {
    hitTimer = killed ? 0.32 : 0.18;
    hitMark.classList.toggle('hud-hitmarker--head', headshot);
    hitMark.classList.toggle('hud-hitmarker--kill', killed);
    hitMark.style.opacity = '1';
  }

  function damageFrom(angle: number) {
    damageAngle = angle;
    damageTimer = 1.1;
    damageArc.style.opacity = '1';
  }

  function setScoreboard(visible: boolean, rows: ScoreRow[]) {
    scoreboard.style.display = visible ? 'flex' : 'none';
    if (!visible) return;

    sbTitle.textContent = 'SCOREBOARD';
    const sorted = [...rows].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);

    sbBody.innerHTML = '';
    const head = el('div', 'hud-scoreboard__row hud-scoreboard__row--head');
    for (const label of ['PLAYER', 'TEAM', 'K', 'D', 'A']) {
      head.appendChild(textCell(label));
    }
    sbBody.appendChild(head);

    for (const row of sorted) {
      const r = el('div', 'hud-scoreboard__row');
      if (row.isPlayer) r.classList.add('hud-scoreboard__row--self');
      const name = textCell(row.name);
      name.classList.add(`hud-scoreboard__team--${row.team}`);
      r.append(name, textCell(TEAM[row.team].name), textCell(String(row.kills)), textCell(String(row.deaths)), textCell(String(row.assists)));
      sbBody.appendChild(r);
    }
  }

  /** Decays the transient elements (hit marker, damage arc) on the real clock. */
  function decay(dt: number) {
    if (hitTimer > 0) {
      hitTimer -= dt;
      if (hitTimer <= 0) hitMark.style.opacity = '0';
    }
    if (damageTimer > 0) {
      damageTimer -= dt;
      damageArc.style.opacity = String(Math.max(0, damageTimer / 1.1));
      if (damageTimer <= 0) damageArc.style.opacity = '0';
    }
    // The damage arc points at the attacker: rotate the whole element so the
    // arc sits on the side the shot came from.
    damageArc.style.transform = `rotate(${damageAngle}rad)`;
  }

  return {
    update(state, dt) {
      update(state);
      decay(dt);
    },
    addKill,
    hitMarker,
    damageFrom,
    setScoreboard,
    dispose() {
      root.innerHTML = '';
    },
  };
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag: string, className: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  node.className = className;
  return node;
}

function textCell(text: string): HTMLDivElement {
  const cell = el('div', 'hud-scoreboard__cell');
  cell.textContent = text;
  return cell;
}

/** Hermite ramp, 0 below `edge0` and 1 above `edge1`. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
