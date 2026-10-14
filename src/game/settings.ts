/**
 * Player-facing settings.
 *
 * Two settings so far, both of which the player must be able to change WITHOUT
 * a rebuild:
 *
 *  - **ADS centre dot.** While aiming down sights the crosshair is hidden,
 *    because the iron sights replace it. Some players still want a precise
 *    centre reference, so a 3 px dot is drawn instead. On by default.
 *  - **Camera bob.** The weapon carries the walk motion and the camera only
 *    hints at it. Some players want none of it at all, so this is a three-way
 *    switch rather than a number.
 *
 * Persisted to localStorage, because a setting that resets on every reload is
 * not a setting. Every access is wrapped: localStorage throws in some privacy
 * modes and in sandboxed iframes, and a settings screen must never be able to
 * stop the game from starting.
 *
 * The full menu system arrives in Phase 5. This is deliberately the smallest
 * thing that lets the two values be changed and remembered.
 */
import { CAMERA } from '../config';

export type CameraBobMode = 'off' | 'low' | 'normal';
export type VolumeMode = 'off' | 'low' | 'normal' | 'high';

/** Master gain for each volume setting. */
export const VOLUME_GAIN: Record<VolumeMode, number> = {
  off: 0,
  low: 0.35,
  normal: 0.75,
  high: 1.1,
};

export interface SettingsValues {
  /** Draw a small dot at the screen centre while aiming down sights. */
  adsCenterDot: boolean;
  /** How much the camera bobs while walking. */
  cameraBob: CameraBobMode;
  /** Master volume. */
  volume: VolumeMode;
}

export const DEFAULT_SETTINGS: SettingsValues = {
  adsCenterDot: true,
  cameraBob: 'low',
  volume: 'normal',
};

/**
 * Multiplier applied to the camera bob amplitude.
 *
 * "Low" is 1x and is the default: the camera bob is already almost nothing
 * (0.5 cm walking, 1 cm sprinting), so "Normal" doubles it for players who want
 * to feel the footsteps.
 */
export const BOB_SCALE: Record<CameraBobMode, number> = {
  off: 0,
  low: 1,
  normal: CAMERA.bob.normalScale,
};

const STORAGE_KEY = 'warehouse-tdm.settings';

export interface Settings {
  readonly values: SettingsValues;
  set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]): void;
  /** Registers a listener called whenever a value changes. */
  onChange(fn: () => void): void;
  /** Registers the handler for the panel's TEST SOUND button. */
  onTestSound(fn: () => void): void;
  show(): void;
  hide(): void;
  readonly visible: boolean;
}

export function createSettings(): Settings {
  const values: SettingsValues = { ...DEFAULT_SETTINGS };
  loadInto(values);

  const listeners = new Set<() => void>();
  const testListeners = new Set<() => void>();
  const panel = buildPanel(values, set, hide, () => {
    for (const fn of testListeners) fn();
  });

  function set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    if (values[key] === value) return;
    values[key] = value;
    save(values);
    panel.sync();
    for (const fn of listeners) fn();
  }

  function show() {
    // The panel needs the mouse, and the game holds the pointer lock while
    // playing. Dropping the lock also brings the boot overlay back — which is
    // why the panel sits above it in the stacking order.
    if (document.pointerLockElement) document.exitPointerLock();
    panel.root.style.display = 'grid';
    panel.sync();
  }

  function hide() {
    panel.root.style.display = 'none';
  }

  return {
    values,
    set,
    onChange(fn) {
      listeners.add(fn);
    },
    onTestSound(fn) {
      testListeners.add(fn);
    },
    show,
    hide,
    get visible() {
      return panel.root.style.display !== 'none';
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadInto(values: SettingsValues) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<SettingsValues>;
    if (typeof parsed.adsCenterDot === 'boolean') values.adsCenterDot = parsed.adsCenterDot;
    if (parsed.cameraBob === 'off' || parsed.cameraBob === 'low' || parsed.cameraBob === 'normal') {
      values.cameraBob = parsed.cameraBob;
    }
    if (parsed.volume && parsed.volume in VOLUME_GAIN) values.volume = parsed.volume;
  } catch {
    // Corrupt or unavailable storage: the defaults are already in place.
  }
}

function save(values: SettingsValues) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Not being able to persist is not a reason to stop the game.
  }
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function buildPanel(
  values: SettingsValues,
  set: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void,
  close: () => void,
  testSound: () => void
): { root: HTMLDivElement; sync: () => void } {
  const root = document.createElement('div');
  root.className = 'settings';
  root.style.display = 'none';

  const panel = document.createElement('div');
  panel.className = 'settings__panel';

  const title = document.createElement('h2');
  title.className = 'settings__title';
  title.textContent = 'SETTINGS';

  const intro = document.createElement('p');
  intro.className = 'settings__intro';
  intro.textContent = 'Saved in this browser. Press ` in game to reopen this panel.';

  panel.append(title, intro);

  const syncers: (() => void)[] = [];

  // ---- ADS centre dot ----
  {
    const row = settingRow(
      'ADS centre dot',
      'Shown while aiming down sights, in place of the crosshair.'
    );
    const group = document.createElement('div');
    group.className = 'settings__group';
    const on = optionButton('ON', () => set('adsCenterDot', true));
    const off = optionButton('OFF', () => set('adsCenterDot', false));
    group.append(on, off);
    row.control.appendChild(group);
    syncers.push(() => {
      on.classList.toggle('settings__option--on', values.adsCenterDot);
      off.classList.toggle('settings__option--on', !values.adsCenterDot);
    });
    panel.appendChild(row.root);
  }

  // ---- camera bob ----
  {
    const row = settingRow(
      'Camera bob',
      "The weapon carries the walk motion; this is the camera's share of it."
    );
    const group = document.createElement('div');
    group.className = 'settings__group';
    const buttons: [CameraBobMode, HTMLButtonElement][] = [];
    for (const mode of ['off', 'low', 'normal'] as CameraBobMode[]) {
      const button = optionButton(mode.toUpperCase(), () => set('cameraBob', mode));
      buttons.push([mode, button]);
      group.appendChild(button);
    }
    row.control.appendChild(group);
    syncers.push(() => {
      for (const [mode, button] of buttons) {
        button.classList.toggle('settings__option--on', values.cameraBob === mode);
      }
    });
    panel.appendChild(row.root);
  }

  // ---- volume ----
  {
    const row = settingRow('Volume', 'TEST plays a gunshot. No sound? Check the tab is not muted.');
    const group = document.createElement('div');
    group.className = 'settings__group';
    const buttons: [VolumeMode, HTMLButtonElement][] = [];
    for (const mode of ['off', 'low', 'normal', 'high'] as VolumeMode[]) {
      const button = optionButton(mode.toUpperCase(), () => set('volume', mode));
      buttons.push([mode, button]);
      group.appendChild(button);
    }
    group.appendChild(optionButton('TEST', testSound));
    row.control.appendChild(group);
    syncers.push(() => {
      for (const [mode, button] of buttons) {
        button.classList.toggle('settings__option--on', values.volume === mode);
      }
    });
    panel.appendChild(row.root);
  }

  const closeButton = document.createElement('button');
  closeButton.className = 'settings__close';
  closeButton.textContent = 'CLOSE';
  closeButton.addEventListener('click', close);
  panel.appendChild(closeButton);

  root.appendChild(panel);
  document.body.appendChild(root);

  const sync = () => {
    for (const fn of syncers) fn();
  };
  sync();

  return { root, sync };
}

function settingRow(label: string, help: string): { root: HTMLDivElement; control: HTMLDivElement } {
  const root = document.createElement('div');
  root.className = 'settings__row';

  const text = document.createElement('div');
  text.className = 'settings__text';

  const name = document.createElement('div');
  name.className = 'settings__name';
  name.textContent = label;

  const hint = document.createElement('div');
  hint.className = 'settings__hint';
  hint.textContent = help;

  text.append(name, hint);

  const control = document.createElement('div');
  control.className = 'settings__control';

  root.append(text, control);
  return { root, control };
}

function optionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'settings__option';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}
