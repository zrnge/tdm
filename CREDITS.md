# Credits

## Developer

- **Developed by:** [zrnge.com](https://zrnge.com)
- **Play:** [zrnge.com/tdm](https://zrnge.com/tdm)
- **Source:** [github.com/zrnge/tdm](https://github.com/zrnge/tdm)
- **Built with AI coding tools:**
  - Navt Coder — model: DeepSeek 4.1 Flash
  - Claude Code — model: Claude Opus 5.5

---

All third-party assets used in this project, with author, source, and license.
All three supplied models are **CC-BY-4.0**, which requires attribution — this file
satisfies that requirement. Do not remove it from any distributed build.

> **This file has an in-game twin.** The same list is rendered by
> `src/hud/credits.ts` behind the **CREDITS** button on the start screen, with
> author, title and a clickable license link for each asset. **If you add an
> asset, add it in both places** — the in-game screen is what a player can
> actually reach, and this file is what a redistributor reads.

---

## 3D Models

### 1. AK74U | FREE ANIMATION. — *supplied by the project owner*

- **Status:** ✅ **USED — first-person ADS viewmodel only.** Its rifle is
  deliberately **not** used for the third-person characters: at 49,666 triangles
  it would put ~400,000 triangles of gun in the scene across 8 characters. The
  arms + rifle are shown only while aiming down sights, where exactly one
  instance exists. See `docs/MODEL-REPORT.md`.
- **Author:** BURNER ([sketchfab.com/Alexander_Ovelar](https://sketchfab.com/Alexander_Ovelar))
- **Source:** https://sketchfab.com/3d-models/ak74u-free-animation-2ab66220c48b465e9501067667965569
- **License:** CC-BY-4.0 — http://creativecommons.org/licenses/by/4.0/
- **File:** `public/models/ak74u__free_animation..glb` (16.37 MB)
- **Contents:** 5 meshes, 69,003 triangles, 50 bones, 7 animation clips
  (DRAW, IDLE, INSPEC, SHOOT, RELOAD1, RELOAD2, OLSER)

### 2. Warehouse FBX Model Free — *supplied by the project owner*

- **Status:** ✅ **USABLE AS THE LEVEL** — interior hall, 16.0 × 46.3 m, 5.02 m
  ceiling. Used as the playable map (see note on size below).
- **Author:** Nicholas-3D ([sketchfab.com/Nicholas01](https://sketchfab.com/Nicholas01))
- **Source:** https://sketchfab.com/3d-models/warehouse-fbx-model-free-daa7fd3ff88945298d00045ca40a4c03
- **License:** CC-BY-4.0 — http://creativecommons.org/licenses/by/4.0/
- **File:** `public/models/warehouse_fbx_model_free.glb` (3.97 MB)
- **Contents:** 3 meshes, 11,106 triangles, no skeleton, no animations
  (materials: `Metal`, `Emissive`, `WetConcrete`)

### 3. Futuristic soldier (Free) — *supplied by the project owner*

- **Status:** ✅ **USED — the bot character.** Full-body rig (58 bones) with its
  own rifle and 18 animation clips (idle, walk, run, strafes, backpedal, crouch,
  shooting, reload, death, ...). The procedural placeholder rifle is not attached
  to it, because the model carries its own.
- **Author:** Pipo Game in My Notebook ([sketchfab.com/pipogamepc18](https://sketchfab.com/pipogamepc18))
- **Source:** https://sketchfab.com/3d-models/futuristic-soldier-free-6515eed4b6114d159de3e9f452c31571
- **License:** CC-BY-4.0 — http://creativecommons.org/licenses/by/4.0/
- **File:** `public/models/futuristic_soldier_free.glb` (6.16 MB)
- **Contents:** 2 skinned meshes (soldier + gun), 7,230 triangles, 58 bones,
  18 animation clips

---

## Software / Libraries

| Library | Version | License | Purpose |
| --- | --- | --- | --- |
| [three.js](https://threejs.org/) | 0.186.1 | MIT | Rendering engine, loaders, post-processing |
| [@dimforge/rapier3d-compat](https://rapier.rs/) | 0.21.0 | Apache-2.0 | Physics, collision, character controller |
| [recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js) | 0.43.1 | Zlib | Navmesh generation, bot pathfinding |
| [stats.js](https://github.com/mrdoob/stats.js/) | 0.17.0 | MIT | FPS counter (debug mode) |
| [vite](https://vite.dev/) | 8.3.4 | MIT | Dev server, bundler |
| [typescript](https://www.typescriptlang.org/) | 7.0.2 | Apache-2.0 | Type checking |

---

## Audio

All files are in `public/audio/`, arranged by the action that makes the sound,
and are mapped to game events in `src/audio/samples.ts`. Every sound also has a
synthesised fallback in `src/audio/audio.ts`.

### 1. Gunshot sounds — SKS recording

- **Author:** Vincent Sevedge (uploaded to OpenGameArt by Tabasco)
- **Source:** https://opengameart.org/content/gunshot-sounds (`sounds.zip`, `sounds/sks.wav`)
- **License:** **CC-BY-3.0** — http://creativecommons.org/licenses/by/3.0/
  The OpenGameArt page lists the pack as CC0, but the `creativecommons.txt`
  inside the archive states "Copyright (c) 2009 Vincent Sevedge … Creative
  Commons Attribution 3.0". The stricter licence is followed here, so
  **attribution is required**.
- **Files:** `weapons/ak/shot_0..3.wav` — four single shots cut from the
  recording (at 0.35 s, 4.20 s, 7.71 s and 9.72 s), 0.42 s each: 60 Hz
  high-pass, the first 35 ms kept intact and the recorded outdoor echo cut away
  with a fast exponential decay (−40 dB by ~0.3 s), peak-normalised to
  −1 dBFS. The SKS fires the same 7.62×39 mm cartridge as the AK.

### 2. Gun reload sounds — assault rifle reload

- **Author:** SpringySpringo
- **Source:** https://opengameart.org/content/gun-reload-sounds (`assaultriflereload1.wav`)
- **License:** CC0-1.0 — http://creativecommons.org/publicdomain/zero/1.0/
- **Files:** cut into the four parts the reload animation schedules separately:
  `weapons/ak/reload_mag_out.wav` (0.12–0.42 s), `reload_mag_in.wav`
  (1.01–1.18 s), `reload_bolt_back.wav` (1.185–1.252 s) and
  `reload_bolt_forward.wav` (1.252–1.52 s), peak-normalised to −3 dBFS.

### 3. Impact Sounds

- **Author:** Kenney (www.kenney.nl)
- **Source:** https://kenney.nl/assets/impact-sounds
- **License:** CC0-1.0 — http://creativecommons.org/publicdomain/zero/1.0/
  (licence text kept as `public/audio/LICENSE-kenney.txt`)
- **Files (renamed, otherwise unmodified):**

  | File | Original |
  | --- | --- |
  | `footsteps/concrete_0..4.ogg` | `footstep_concrete_000..004.ogg` |
  | `impacts/metal_0..2.ogg` | `impactMetal_light_000..002.ogg` |
  | `impacts/concrete_0..2.ogg` | `impactGeneric_light_000..002.ogg` |
  | `impacts/wood_0..2.ogg` | `impactWood_light_000..002.ogg` |
  | `impacts/flesh_0..2.ogg` | `impactPunch_medium_000..002.ogg` |
  | `player/hurt_0..2.ogg` | `impactPunch_heavy_000..002.ogg` |
  | `body/fall_0..2.ogg` | `impactSoft_heavy_000..002.ogg` |

---

## Placeholder assets still required

These are **not yet present**. Until they are supplied, the game uses the
procedural fallbacks described in `docs/MODEL-REPORT.md`.

| Asset | Needed for | Suggested free source |
| --- | --- | --- |
| Low-poly AK rifle (~1–5k tris) | Third-person weapon, all 8 characters | [Quaternius Ultimate Guns Pack](https://quaternius.com/) (CC0) — see `docs/MIXAMO-SETUP.md` §5 |
| PBR concrete / metal / corrugated textures | Level surfaces | [Poly Haven](https://polyhaven.com/) (CC0) |
| Industrial HDRI | Environment lighting | [Poly Haven HDRIs](https://polyhaven.com/hdris) (CC0) |
| Shipping containers, crates, pallet racks | Cover props | [Quaternius](https://quaternius.com/) / [Kenney](https://kenney.nl/) (CC0) |
