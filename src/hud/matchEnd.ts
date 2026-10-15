/**
 * The end-of-match screen: who won, the final score and scoreboard, PLAY AGAIN
 * and MAIN MENU. With no choice made it returns to the main menu on its own
 * after `MATCH.endScreenSeconds`, counting down on screen.
 */
import { MATCH, TEAM, type TeamId } from '../config';
import type { ScoreRow } from './hud';

export interface MatchEndResult {
  /** Winning team, or null for a draw. */
  winner: TeamId | null;
  scores: Record<TeamId, number>;
  rows: ScoreRow[];
  /** The player's team, to say "VICTORY" or "DEFEAT". */
  playerTeam: TeamId;
}

export interface MatchEndScreen {
  show(result: MatchEndResult): void;
  hide(): void;
  readonly visible: boolean;
  /** Tells the player the browser refused the mouse, so they click again. */
  lockRefused(): void;
}

export interface MatchEndOptions {
  onPlayAgain(): void;
  onMainMenu(): void;
}

export function createMatchEndScreen(opts: MatchEndOptions): MatchEndScreen {
  const root = document.createElement('div');
  root.className = 'pause match-end';
  root.style.display = 'none';

  const panel = document.createElement('div');
  panel.className = 'pause__panel match-end__panel';
  root.appendChild(panel);

  const title = document.createElement('h2');
  title.className = 'pause__title';
  const subtitle = document.createElement('p');
  subtitle.className = 'match-end__score';
  const table = document.createElement('table');
  table.className = 'match-end__table';
  const countdown = document.createElement('p');
  countdown.className = 'pause__hint';
  panel.append(title, subtitle, table);

  const playAgain = document.createElement('button');
  playAgain.className = 'boot__button pause__button';
  playAgain.textContent = 'PLAY AGAIN';
  playAgain.addEventListener('click', () => opts.onPlayAgain());
  const mainMenu = document.createElement('button');
  mainMenu.className = 'boot__button boot__button--ghost pause__button';
  mainMenu.textContent = 'MAIN MENU';
  mainMenu.addEventListener('click', () => opts.onMainMenu());
  panel.append(playAgain, mainMenu, countdown);

  document.body.appendChild(root);

  let timer = 0;
  let deadline = 0;

  function tick() {
    const left = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    countdown.textContent = `Returning to the main menu in ${left}s`;
    if (left <= 0) {
      stop();
      opts.onMainMenu();
    }
  }

  function stop() {
    if (timer) window.clearInterval(timer);
    timer = 0;
  }

  return {
    show(result) {
      const won = result.winner === result.playerTeam;
      title.textContent = result.winner === null ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
      title.classList.toggle('match-end__title--win', won);
      title.classList.toggle('match-end__title--loss', result.winner !== null && !won);
      subtitle.textContent =
        `${TEAM.blue.name} ${result.scores.blue} : ${result.scores.red} ${TEAM.red.name}`;

      table.replaceChildren();
      const head = table.insertRow();
      for (const h of ['PLAYER', 'K', 'D']) {
        const th = document.createElement('th');
        th.textContent = h;
        head.appendChild(th);
      }
      const rows = [...result.rows].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      for (const r of rows) {
        const tr = table.insertRow();
        tr.className = `match-end__row match-end__row--${r.team}${r.isPlayer ? ' match-end__row--you' : ''}`;
        for (const v of [r.name, String(r.kills), String(r.deaths)]) tr.insertCell().textContent = v;
      }

      root.style.display = 'grid';
      stop();
      deadline = performance.now() + MATCH.endScreenSeconds * 1000;
      tick();
      timer = window.setInterval(tick, 250);
      playAgain.focus();
    },
    hide() {
      stop();
      root.style.display = 'none';
    },
    get visible() {
      return root.style.display !== 'none';
    },
    lockRefused() {
      countdown.textContent = 'The browser needs a moment — click PLAY AGAIN again.';
    },
  };
}
