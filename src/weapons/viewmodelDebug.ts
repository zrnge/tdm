/**
 * Viewmodel tuning tool (F4).
 *
 * The viewmodel's hold transform cannot be derived from first principles: the
 * numbers that put the hands in the lower-right of the screen and the iron
 * sights on the screen centre are a matter of taste as much as geometry.
 *
 * So they are tuned visually. Press F4, nudge with the keys below, and press P
 * to print a `VIEWMODEL` block that can be pasted straight into `src/config.ts`.
 *
 * ## What is NOT tuned here
 *
 * The barrel/sights alignment is measured from the posed geometry at load (see
 * `viewmodelAlign.ts`) and should not need touching. The ORIENT page exists only
 * as an escape hatch for an asset whose magazine is not a reliable "down"
 * reference.
 *
 * ## The ADS auto-solve (A)
 *
 * Aiming down sights has an exact answer rather than a hand-tuned one. After
 * alignment the bore line runs along -Z in the root's space, so for the iron
 * sights to sit on the screen centre the bore line must be collinear with the
 * camera's own -Z axis:
 *
 *   rotation = identity          (the barrel already points where the camera does)
 *   position = -boreOrigin       (slide the bore line onto the camera axis)
 *
 * Pressing `A` computes exactly that. Hand-tuning from there is only needed if
 * the sights are not on the bore line.
 *
 * Movement is suppressed while the tool is open so the keys are free to drive
 * the viewmodel instead of the player.
 */
import { VIEWMODEL } from '../config';
import type { InputState } from '../core/input';
import type { Viewmodel, ViewmodelHolds, Vec3 } from './viewmodel';

export interface ViewmodelDebug {
  readonly active: boolean;
  readonly holds: ViewmodelHolds;
  /** Which page the keys currently drive. */
  readonly mode: 'hip' | 'ads' | 'orient';
  update(dt: number): void;
  print(): void;
  dispose(): void;
}

/** Movement speeds at the base step size. Shift divides by 10, Ctrl multiplies by 10. */
const SPEED = {
  position: 0.15, // metres per second
  rotation: 30, // degrees per second
  scale: 0.2, // units per second
} as const;

const PAGES = ['hip', 'ads', 'orient'] as const;

export function createViewmodelDebug(
  input: InputState,
  getViewmodel: () => Viewmodel | null
): ViewmodelDebug {
  let active = false;
  let mode: 'hip' | 'ads' | 'orient' = 'hip';
  const overlay = buildOverlay();

  const holds = () => getViewmodel()?.holds ?? null;

  /**
   * The hold block the keys currently drive.
   *
   * `position` is absent on the ORIENT page, which has no translation — the
   * alignment is a pure rotation and moving it would only slide the model off
   * its anchor.
   */
  function current(): { position?: Vec3; rotation: Vec3 } | null {
    const h = holds();
    if (!h) return null;
    if (mode === 'orient') return h.orient;
    return mode === 'hip' ? h.hip : h.ads;
  }

  const print = () => {
    const h = holds();
    if (!h) {
      console.warn('[viewmodel] no viewmodel loaded — nothing to print');
      return;
    }
    const block = (name: string, hold: { position: Vec3; rotation: Vec3 }) =>
      `  ${name}: {\n` +
      `    position: { x: ${hold.position.x.toFixed(4)}, y: ${hold.position.y.toFixed(4)}, z: ${hold.position.z.toFixed(4)} },\n` +
      `    rotation: { x: ${hold.rotation.x.toFixed(2)}, y: ${hold.rotation.y.toFixed(2)}, z: ${hold.rotation.z.toFixed(2)} },\n` +
      `  },`;
    console.log(
      `[viewmodel] paste into VIEWMODEL in src/config.ts:\n` +
        block('hip', h.hip) +
        '\n' +
        block('ads', h.ads) +
        '\n' +
        `  orient: {\n` +
        `    rotation: { x: ${h.orient.rotation.x.toFixed(2)}, y: ${h.orient.rotation.y.toFixed(2)}, z: ${h.orient.rotation.z.toFixed(2)} },\n` +
        `  },\n` +
        `  scale: ${h.scale.toFixed(4)},`
    );
  };

  /**
   * Solves the ADS hold from the measured sight line, so the iron sights land on
   * the screen centre. See the module comment for the derivation.
   */
  const solveAds = () => {
    const vm = getViewmodel();
    if (!vm) {
      console.warn('[viewmodel] no viewmodel loaded — cannot solve ADS');
      return;
    }
    // The solve itself lives in `viewmodel.ts`, because it is the same code that
    // runs at load. Duplicating it here is how the tool and the game drift apart.
    vm.solveAds();
  };

  const setActive = (on: boolean) => {
    active = on;
    overlay.root.style.display = on ? 'block' : 'none';
    if (on) {
      console.log(
        `[viewmodel] tuning ON (${mode.toUpperCase()}) — Tab switches HIP/ADS/ORIENT, ` +
          `arrows move, PageUp/PageDown lift, I/K pitch, J/L yaw, U/O roll, -/+ scale, ` +
          `A solve ADS from the bore line, Shift fine, Ctrl coarse, P print, R reset, F4 close.`
      );
    } else {
      print();
    }
  };

  return {
    get active() {
      return active;
    },
    get holds() {
      return holds() as ViewmodelHolds;
    },
    get mode() {
      return mode;
    },

    update(dt) {
      if (input.pressed('debugViewmodel')) setActive(!active);
      if (!active) return;

      const h = holds();
      if (!h) return;

      // Tab switches which hold the keys drive. Read raw, because Tab is mapped
      // to the scoreboard and the scoreboard must not open while tuning.
      if (input.pressedRaw('Tab')) {
        const next = (PAGES.indexOf(mode) + 1) % PAGES.length;
        mode = PAGES[next];
        console.log(`[viewmodel] editing ${mode.toUpperCase()}`);
      }

      // Step size: Shift for fine control, Ctrl for coarse.
      let step = dt;
      if (input.keysDown.has('ShiftLeft') || input.keysDown.has('ShiftRight')) step *= 0.1;
      if (input.keysDown.has('ControlLeft') || input.keysDown.has('ControlRight')) step *= 10;

      const k = input.keysDown;
      const held = (...codes: string[]) => codes.some((c) => k.has(c));
      const hold = current();
      if (!hold) return;

      // ---- position ----
      if (hold.position) {
        if (held('ArrowUp')) hold.position.z -= SPEED.position * step;
        if (held('ArrowDown')) hold.position.z += SPEED.position * step;
        if (held('ArrowLeft')) hold.position.x -= SPEED.position * step;
        if (held('ArrowRight')) hold.position.x += SPEED.position * step;
        if (held('PageUp')) hold.position.y += SPEED.position * step;
        if (held('PageDown')) hold.position.y -= SPEED.position * step;
      }

      // ---- rotation, degrees ----
      if (held('KeyI')) hold.rotation.x -= SPEED.rotation * step;
      if (held('KeyK')) hold.rotation.x += SPEED.rotation * step;
      if (held('KeyJ')) hold.rotation.y -= SPEED.rotation * step;
      if (held('KeyL')) hold.rotation.y += SPEED.rotation * step;
      if (held('KeyU')) hold.rotation.z -= SPEED.rotation * step;
      if (held('KeyO')) hold.rotation.z += SPEED.rotation * step;

      // ---- scale ----
      if (held('Minus')) h.scale = Math.max(0.05, h.scale - SPEED.scale * step);
      if (held('Equal')) h.scale = Math.min(5, h.scale + SPEED.scale * step);

      if (input.pressedRaw('KeyA')) solveAds();
      if (input.pressedRaw('KeyP')) print();
      if (input.pressedRaw('KeyR')) {
        h.hip.position = { ...VIEWMODEL.hip.position };
        h.hip.rotation = { ...VIEWMODEL.hip.rotation };
        h.ads.position = { ...VIEWMODEL.ads.position };
        h.ads.rotation = { ...VIEWMODEL.ads.rotation };
        h.orient.rotation = { ...VIEWMODEL.orient.rotation };
        h.scale = VIEWMODEL.scale;
        console.log('[viewmodel] reset to the values in src/config.ts');
      }

      const vm = getViewmodel();
      const m = vm?.muzzle;
      const posLine = hold.position
        ? `pos ${hold.position.x.toFixed(3)}, ${hold.position.y.toFixed(3)}, ${hold.position.z.toFixed(3)}\n`
        : 'pos (none — ORIENT is rotation only)\n';
      // The sight report is the whole point of the ADS page: it says whether the
      // eye is actually looking through the notch. `front` must be (0, 0) and
      // `axis` must be 0 degrees off.
      const sr = vm?.sightReport;
      const sightLine = sr
        ? `sights front ${sr.front.x.toFixed(4)}, ${sr.front.y.toFixed(4)} (want 0, 0)\n` +
          `axis ${sr.offAxisDegrees.toFixed(3)}° off (want 0)\n` +
          `rear z ${sr.rear.z.toFixed(3)}${sr.rearClipped ? ' CLIPPED' : ''}\n`
        : '';
      overlay.readout.textContent =
        `editing ${mode.toUpperCase()}\n` +
        posLine +
        `rot ${hold.rotation.x.toFixed(1)}°, ${hold.rotation.y.toFixed(1)}°, ${hold.rotation.z.toFixed(1)}°\n` +
        `scale ${h.scale.toFixed(3)}\n` +
        sightLine +
        (m
          ? `muzzle ${m.x.toFixed(3)}, ${m.y.toFixed(3)}, ${m.z.toFixed(3)}` +
            `\nidle ${vm?.idlePlaying ? 'playing' : 'STOPPED'}` +
            `\nreload ${vm?.reloading ? `${(vm.reloadProgress * 100).toFixed(0)}%` : 'no'}`
          : '');
    },

    print,

    dispose() {
      overlay.root.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// On-screen readout
// ---------------------------------------------------------------------------

function buildOverlay(): { root: HTMLDivElement; readout: HTMLPreElement } {
  const root = document.createElement('div');
  root.className = 'grip-debug';
  root.style.display = 'none';

  const title = document.createElement('div');
  title.className = 'grip-debug__title';
  title.textContent = 'VIEWMODEL TUNING (F4 to close)';

  const help = document.createElement('div');
  help.className = 'grip-debug__help';
  help.innerHTML =
    '<b>Tab</b> HIP / ADS / ORIENT &nbsp; <b>Arrows</b> move &nbsp; <b>PgUp/PgDn</b> lift &nbsp; ' +
    '<b>I/K</b> pitch &nbsp; <b>J/L</b> yaw &nbsp; <b>U/O</b> roll<br>' +
    '<b>-/+</b> scale &nbsp; <b>A</b> re-solve ADS from the measured sights &nbsp; <b>Shift</b> fine &nbsp; ' +
    '<b>Ctrl</b> coarse &nbsp; <b>P</b> print &nbsp; <b>R</b> reset';

  const readout = document.createElement('pre');
  readout.className = 'grip-debug__readout';

  root.append(title, help, readout);
  (document.getElementById('hud') ?? document.body).appendChild(root);

  return { root, readout };
}

export type { Vec3 };
