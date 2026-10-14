/**
 * Grip tuning tool (F4).
 *
 * The rifle's transform inside the hand bone's local space cannot be derived
 * from first principles. Mixamo hand bones carry their own axis convention, it
 * differs between rigs, and the rifle geometry is authored in a third space
 * again. Guessing produces a rifle floating beside the character's knee.
 *
 * So it is tuned visually instead: press F4, nudge the grip with the keys below,
 * and press P to print a `RIFLE.grip` block that can be pasted straight into
 * `src/config.ts`. Every character's rifle updates live, so the offset can be
 * judged from any angle while the camera orbits.
 *
 * Player movement is suppressed while the tool is open, so the character stands
 * still and the keys are free to drive the grip instead.
 */
import * as THREE from 'three';
import { RIFLE } from '../config';
import type { InputState } from '../core/input';

export interface GripValues {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: number;
}

export interface GripDebug {
  readonly active: boolean;
  readonly values: GripValues;
  /** Call once per frame, before rendering. */
  update(dt: number): void;
  /** Prints the current values as a paste-ready config block. */
  print(): void;
  dispose(): void;
}

/** Movement speeds at the base step size. Shift divides by 10, Ctrl multiplies by 10. */
const SPEED = {
  position: 0.25, // metres per second
  rotation: 45, // degrees per second
  scale: 0.25, // units per second
} as const;

export function createGripDebug(
  input: InputState,
  getTargets: () => THREE.Object3D[]
): GripDebug {
  // Copied out of the frozen config into mutable numbers. The explicit `: number`
  // annotations matter: RIFLE is `as const`, so without them these would be
  // inferred as the literal type 0 and reject every assignment below.
  const values: GripValues = {
    position: { x: RIFLE.grip.position.x, y: RIFLE.grip.position.y, z: RIFLE.grip.position.z },
    rotation: { x: RIFLE.grip.rotation.x, y: RIFLE.grip.rotation.y, z: RIFLE.grip.rotation.z },
    scale: RIFLE.grip.scale,
  };

  const defaults = JSON.parse(JSON.stringify(values)) as GripValues;

  let active = false;
  const overlay = buildOverlay();

  /** Pushes the current values onto every character's rifle. */
  const apply = () => {
    for (const target of getTargets()) {
      target.position.set(values.position.x, values.position.y, values.position.z);
      target.rotation.set(
        THREE.MathUtils.degToRad(values.rotation.x),
        THREE.MathUtils.degToRad(values.rotation.y),
        THREE.MathUtils.degToRad(values.rotation.z)
      );
      target.scale.setScalar(values.scale);
    }
  };

  const print = () => {
    const p = values.position;
    const r = values.rotation;
    console.log(
      `[grip] paste into RIFLE.grip in src/config.ts:\n` +
        `  grip: {\n` +
        `    position: { x: ${p.x.toFixed(4)}, y: ${p.y.toFixed(4)}, z: ${p.z.toFixed(4)} },\n` +
        `    rotation: { x: ${r.x.toFixed(2)}, y: ${r.y.toFixed(2)}, z: ${r.z.toFixed(2)} },\n` +
        `    scale: ${values.scale.toFixed(4)},\n` +
        `  },`
    );
  };

  const setActive = (on: boolean) => {
    active = on;
    overlay.root.style.display = on ? 'block' : 'none';
    if (on) {
      console.log(
        `[grip] tuning ON — arrows move, PageUp/PageDown lift, I/K pitch, J/L yaw, U/O roll, ` +
          `-/+ scale, Shift fine, Ctrl coarse, P print, R reset, F4 close.`
      );
    } else {
      print();
    }
  };

  return {
    get active() {
      return active;
    },
    values,

    update(dt: number) {
      if (input.pressed('debugRifleGrip')) setActive(!active);
      if (!active) return;

      // Step size: Shift for fine control, Ctrl for coarse.
      let step = dt;
      if (input.keysDown.has('ShiftLeft') || input.keysDown.has('ShiftRight')) step *= 0.1;
      if (input.keysDown.has('ControlLeft') || input.keysDown.has('ControlRight')) step *= 10;

      const k = input.keysDown;
      const held = (...codes: string[]) => codes.some((c) => k.has(c));

      // ---- position ----
      // Arrows move along the barrel (Z) and across it (X); PageUp/Down lift.
      if (held('ArrowUp')) values.position.z -= SPEED.position * step;
      if (held('ArrowDown')) values.position.z += SPEED.position * step;
      if (held('ArrowLeft')) values.position.x -= SPEED.position * step;
      if (held('ArrowRight')) values.position.x += SPEED.position * step;
      if (held('PageUp')) values.position.y += SPEED.position * step;
      if (held('PageDown')) values.position.y -= SPEED.position * step;

      // ---- rotation, degrees ----
      if (held('KeyI')) values.rotation.x -= SPEED.rotation * step;
      if (held('KeyK')) values.rotation.x += SPEED.rotation * step;
      if (held('KeyJ')) values.rotation.y -= SPEED.rotation * step;
      if (held('KeyL')) values.rotation.y += SPEED.rotation * step;
      if (held('KeyU')) values.rotation.z -= SPEED.rotation * step;
      if (held('KeyO')) values.rotation.z += SPEED.rotation * step;

      // ---- scale ----
      if (held('Minus')) values.scale = Math.max(0.05, values.scale - SPEED.scale * step);
      if (held('Equal')) values.scale = Math.min(5, values.scale + SPEED.scale * step);

      if (input.pressedRaw('KeyP')) print();
      if (input.pressedRaw('KeyR')) {
        Object.assign(values, JSON.parse(JSON.stringify(defaults)));
        console.log('[grip] reset to the values in src/config.ts');
      }

      apply();
      overlay.readout.textContent =
        `pos ${values.position.x.toFixed(3)}, ${values.position.y.toFixed(3)}, ${values.position.z.toFixed(3)}\n` +
        `rot ${values.rotation.x.toFixed(1)}°, ${values.rotation.y.toFixed(1)}°, ${values.rotation.z.toFixed(1)}°\n` +
        `scale ${values.scale.toFixed(3)}`;
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
  title.textContent = 'GRIP TUNING (F4 to close)';

  const help = document.createElement('div');
  help.className = 'grip-debug__help';
  help.innerHTML =
    '<b>Arrows</b> move &nbsp; <b>PgUp/PgDn</b> lift &nbsp; <b>I/K</b> pitch &nbsp; ' +
    '<b>J/L</b> yaw &nbsp; <b>U/O</b> roll<br>' +
    '<b>-/+</b> scale &nbsp; <b>Shift</b> fine &nbsp; <b>Ctrl</b> coarse &nbsp; ' +
    '<b>P</b> print &nbsp; <b>R</b> reset';

  const readout = document.createElement('pre');
  readout.className = 'grip-debug__readout';

  root.append(title, help, readout);
  (document.getElementById('hud') ?? document.body).appendChild(root);

  return { root, readout };
}
