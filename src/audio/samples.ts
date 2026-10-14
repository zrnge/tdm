/**
 * Recorded sound samples, by gameplay action.
 *
 * The files live in `public/audio/`, laid out by what makes the sound:
 *
 *     weapons/ak/   shot_*, reload_mag_out, reload_mag_in, reload_bolt_back,
 *                   reload_bolt_forward
 *     footsteps/    concrete_*            (the warehouse floor)
 *     impacts/      metal_*, concrete_*, wood_*, flesh_*
 *     player/       hurt_*
 *     body/         fall_*
 *
 * Each action has several takes; `pick()` chooses one at random, never the same
 * take twice in a row, so a burst of fire or a run of footsteps does not sound
 * like one sample on repeat. Sources and licences are in CREDITS.md.
 *
 * Loading is fire-and-forget once the AudioContext exists. Until a sample has
 * decoded — or if its file is missing — `pick()` returns null and `audio.ts`
 * falls back to its synthesised version of the sound, so the game is never
 * silent and never waits on the network.
 */

export type SampleKey =
  | 'gunshot'
  | 'reloadMagOut'
  | 'reloadMagIn'
  | 'reloadBoltBack'
  | 'reloadBoltForward'
  | 'footstepConcrete'
  | 'impactMetal'
  | 'impactConcrete'
  | 'impactWood'
  | 'impactFlesh'
  | 'hurt'
  | 'bodyfall';

const takes = (path: string, ext: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${path}_${i}.${ext}`);

/** Every file per action, relative to `public/audio/`. */
export const SAMPLE_FILES: Record<SampleKey, string[]> = {
  gunshot: takes('weapons/ak/shot', 'wav', 4),
  reloadMagOut: ['weapons/ak/reload_mag_out.wav'],
  reloadMagIn: ['weapons/ak/reload_mag_in.wav'],
  reloadBoltBack: ['weapons/ak/reload_bolt_back.wav'],
  reloadBoltForward: ['weapons/ak/reload_bolt_forward.wav'],
  footstepConcrete: takes('footsteps/concrete', 'ogg', 5),
  impactMetal: takes('impacts/metal', 'ogg', 3),
  impactConcrete: takes('impacts/concrete', 'ogg', 3),
  impactWood: takes('impacts/wood', 'ogg', 3),
  impactFlesh: takes('impacts/flesh', 'ogg', 3),
  hurt: takes('player/hurt', 'ogg', 3),
  bodyfall: takes('body/fall', 'ogg', 3),
};

/**
 * Seconds from the start of a sample to its transient, for samples that must
 * land exactly on an animation beat. The cut leaves a few milliseconds of
 * lead-in so the attack is not clipped; scheduling subtracts it.
 */
export const SAMPLE_LEAD: Partial<Record<SampleKey, number>> = {
  reloadMagIn: 0.033,
  reloadBoltBack: 0.015,
};

export interface SampleBank {
  /** A random decoded take for `key`, or null if none has loaded. */
  pick(key: SampleKey): AudioBuffer | null;
}

export function loadSamples(ctx: BaseAudioContext): SampleBank {
  // Under Vite's base path, like the model URLs in config.ts.
  const base = `${import.meta.env.BASE_URL}audio/`;
  const buffers = new Map<SampleKey, AudioBuffer[]>();
  const lastTake = new Map<SampleKey, AudioBuffer>();
  let loaded = 0;
  let failed = 0;
  const total = Object.values(SAMPLE_FILES).reduce((n, files) => n + files.length, 0);

  const report = () => {
    if (loaded + failed < total) return;
    console.log(`[audio] samples: ${loaded}/${total} loaded${failed ? `, ${failed} missing (synth fallback)` : ''}`);
  };

  for (const [key, files] of Object.entries(SAMPLE_FILES) as [SampleKey, string[]][]) {
    for (const file of files) {
      fetch(base + file)
        .then((res) => {
          if (!res.ok) throw new Error(`${res.status}`);
          return res.arrayBuffer();
        })
        .then((data) => ctx.decodeAudioData(data))
        .then((buffer) => {
          const list = buffers.get(key) ?? [];
          list.push(buffer);
          buffers.set(key, list);
          loaded++;
          report();
        })
        .catch((err) => {
          failed++;
          console.warn(`[audio] could not load ${file}: ${(err as Error).message}`);
          report();
        });
    }
  }

  return {
    pick(key) {
      const list = buffers.get(key);
      if (!list?.length) return null;
      if (list.length === 1) return list[0];
      const last = lastTake.get(key);
      let take = list[Math.floor(Math.random() * list.length)];
      if (take === last) take = list[(list.indexOf(take) + 1) % list.length];
      lastTake.set(key, take);
      return take;
    },
  };
}
