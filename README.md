# Warehouse TDM

A browser-based first-person shooter: you, alone on BLUE, against four RED bots
in a weathered steel warehouse. Built with [three.js](https://threejs.org/),
[Rapier](https://rapier.rs/) physics and
[recast-navigation](https://github.com/isaac-mason/recast-navigation-js) for bot
pathfinding.

- **Play:** [zrnge.com/tdm](https://zrnge.com/tdm)
- **Source:** [github.com/zrnge/tdm](https://github.com/zrnge/tdm)
- **Developer:** [zrnge.com](https://zrnge.com)

## Built with

- **Navy Coder** — model: DeepSeek 4.1 Flash
- **Claude Code** — model: Claude Opus 5.5

## Run it

Requires Node.js 20.19+ (or 22.12+).

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # type-check + production build into dist/
npm run preview    # serve the build at http://localhost:4173/tdm/
```

The production build is made for **zrnge.com/tdm**: every asset URL is under
`/tdm/` (Vite `base`, set in `vite.config.ts`). Upload the contents of `dist/`
to the server's `tdm/` folder. To host somewhere else, change `base` there.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows | Move |
| Shift | Sprint |
| C / Ctrl | Crouch |
| Space | Jump |
| Mouse | Aim |
| Left mouse | Fire |
| Right mouse | Aim down sights |
| R | Reload |
| V | Inspect weapon |
| Tab | Scoreboard |
| Esc | Pause menu |
| `` ` `` | Settings |
| F3 / F4 / F5 / F6 | Debug: overlay, viewmodel tuning, rifle grip, colliders |

## Project layout

| Path | Contents |
| --- | --- |
| `src/` | Game code: `core/` engine, input, physics · `player/` · `weapons/` · `bots/` AI · `combat/` · `level/` map, cover, weathering · `audio/` · `hud/` · `nav/` navmesh |
| `public/models/` | 3D models (GLB) |
| `public/audio/` | Sound effects, arranged by action |
| `docs/` | Asset inspection notes |
| `tools/` | Node scripts for inspecting the GLB assets (`npm run inspect:glb`) |

## Credits

All third-party models and sounds are listed with author, source and license
in [CREDITS.md](CREDITS.md) and on the in-game **CREDITS** screen. Several
assets are **CC-BY**, which requires that attribution — keep both when
redistributing.
