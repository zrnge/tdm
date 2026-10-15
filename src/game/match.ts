/**
 * Match state: team scores, the clock, the win condition, and the scoreboard.
 *
 * Kept separate from `combat.ts` because combat knows about individuals and this
 * knows about teams. Phase 3 feeds bot kills into exactly the same `record()`
 * call the player's kills go through.
 */
import { MATCH, TEAM, type TeamId } from '../config';
import type { Combatant } from '../combat/combat';
import type { ScoreRow } from '../hud/hud';

export interface MatchState {
  readonly running: boolean;
  readonly over: boolean;
  /** Winning team, once the match is over. */
  readonly winner: TeamId | null;
  /** Seconds left. */
  readonly timeRemaining: number;
  readonly scores: Record<TeamId, number>;
  /** Records a kill for the attacker's team. */
  record(attacker: Combatant | null, victim: Combatant): void;
  update(dt: number): void;
  /** Builds the scoreboard rows from the combatant list. */
  scoreboard(combatants: Combatant[], playerId: string): ScoreRow[];
  /** Resets scores and the clock. */
  reset(): void;
}

export interface MatchOptions {
  /** Called once when the match ends, with the winner or null for a draw. */
  onEnd?(winner: TeamId | null): void;
}

export function createMatch(opts: MatchOptions = {}): MatchState {
  const scores: Record<TeamId, number> = { blue: 0, red: 0 };
  let timeRemaining: number = MATCH.timeLimit;
  let running = true;
  let over = false;
  let winner: TeamId | null = null;

  function endMatch(win: TeamId) {
    if (over) return;
    over = true;
    running = false;
    winner = win;
    console.log(
      `[match] over — ${TEAM[win].name} wins ${scores.blue} : ${scores.red}`
    );
    opts.onEnd?.(win);
  }

  return {
    get running() {
      return running;
    },
    get over() {
      return over;
    },
    get winner() {
      return winner;
    },
    get timeRemaining() {
      return timeRemaining;
    },
    get scores() {
      return scores;
    },

    record(attacker, victim) {
      if (over) return;
      // A suicide or a team kill scores for the opposing team, which is the
      // standard rule and stops "kill yourself to deny the enemy" abuse.
      const scoringTeam: TeamId =
        attacker && attacker.team !== victim.team
          ? attacker.team
          : victim.team === 'blue'
            ? 'red'
            : 'blue';

      scores[scoringTeam]++;
      if (scores[scoringTeam] >= MATCH.killLimit) endMatch(scoringTeam);
    },

    update(dt) {
      if (!running) return;
      timeRemaining -= dt;
      if (timeRemaining <= 0) {
        timeRemaining = 0;
        // Time expired: the higher score wins, and a tie goes to neither.
        if (scores.blue > scores.red) endMatch('blue');
        else if (scores.red > scores.blue) endMatch('red');
        else {
          over = true;
          running = false;
          winner = null;
          console.log(`[match] over — draw at ${scores.blue} : ${scores.red}`);
          opts.onEnd?.(null);
        }
      }
    },

    scoreboard(combatants, playerId) {
      return combatants.map((c) => ({
        name: c.id === playerId ? `${c.id} (you)` : c.id,
        team: c.team,
        kills: c.kills,
        deaths: c.deaths,
        assists: c.assists,
        isPlayer: c.id === playerId,
      }));
    },

    reset() {
      scores.blue = 0;
      scores.red = 0;
      timeRemaining = MATCH.timeLimit;
      running = true;
      over = false;
      winner = null;
    },
  };
}
