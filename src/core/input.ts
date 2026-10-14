/**
 * Keyboard + mouse input. Tracks held state and per-frame edge transitions so
 * gameplay code can ask `wasPressed('KeyR')` without wiring its own listeners.
 *
 * Pointer lock is owned here too: the game only receives mouse-look deltas
 * while the canvas holds the lock.
 */

export type InputAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'crouch'
  | 'jump'
  | 'reload'
  | 'inspect'
  | 'weapon1'
  | 'weapon2'
  | 'scoreboard'
  | 'debug'
  | 'debugViewmodel'
  | 'debugRifleGrip'
  | 'debugColliders'
  | 'settings';

/** Maps an action to the KeyboardEvent.code values that trigger it. */
const KEY_MAP: Record<string, InputAction> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyC: 'crouch',
  ControlLeft: 'crouch',
  Space: 'jump',
  KeyR: 'reload',
  // V plays the weapon's INSPEC clip. There is no Q shoulder swap any more:
  // the player is first-person, so there is no shoulder to swap.
  KeyV: 'inspect',
  Digit1: 'weapon1',
  Digit2: 'weapon2',
  Tab: 'scoreboard',
  F3: 'debug',
  // F4 tunes the first-person viewmodel (the thing the player actually sees);
  // F5 tunes the bots' third-person rifle grip; F6 draws every Rapier collider
  // as a wireframe and audits the cover colliders against their meshes.
  F4: 'debugViewmodel',
  F5: 'debugRifleGrip',
  F6: 'debugColliders',
  // The settings panel. Backquote is the conventional "console/settings" key and
  // is free on every layout this game targets.
  Backquote: 'settings',
};

/**
 * Actions suppressed by `setMovementLocked`. Debug actions are deliberately
 * absent: locking movement must never lock the key that unlocks it.
 */
const MOVEMENT_ACTIONS = new Set<InputAction>([
  'forward',
  'back',
  'left',
  'right',
  'sprint',
  'crouch',
  'jump',
]);

export interface InputState {  /** True while the action's key is down. */
  active(action: InputAction): boolean;
  /** True only on the frame the action's key went down. */
  pressed(action: InputAction): boolean;
  /** True only on the frame the action's key came up. */
  released(action: InputAction): boolean;
  /** Accumulated mouse delta since the last `endFrame()`, in pixels. */
  readonly mouseDX: number;
  readonly mouseDY: number;
  /** True while the right mouse button is held (aim down sights). */
  readonly aiming: boolean;
  readonly firing: boolean;
  /** True when the canvas currently owns the pointer lock. */
  readonly pointerLocked: boolean;
  /**
   * Every key code currently held, unprocessed.
   *
   * The grip tuning tool needs keys the game does not map (arrows, PageUp,
   * I/J/K/L/U/O, +/-), and adding a named action for each would bloat the
   * action list for one debug feature. Debug tools read this instead.
   */
  readonly keysDown: ReadonlySet<string>;
  /**
   * True on the frame a raw key code went down, whether or not it is mapped.
   * Same rationale as `keysDown`.
   */
  pressedRaw(code: string): boolean;
  /**
   * While true, the movement actions (WASD, sprint, crouch, jump) report as
   * inactive. Mouse-look and every debug action keep working.
   *
   * The grip tuning tool needs the character to stand still while its own keys
   * drive the rifle, but the camera must still orbit so the grip can be judged
   * from the side.
   */
  setMovementLocked(locked: boolean): void;
  /** Clears per-frame edge state. Call once at the end of every update. */
  endFrame(): void;
  /** Releases every listener. */
  dispose(): void;
}

export function createInput(canvas: HTMLCanvasElement): InputState {
  const down = new Set<InputAction>();
  const pressedThisFrame = new Set<InputAction>();
  const releasedThisFrame = new Set<InputAction>();

  // Raw key state, for debug tools that need keys the game does not map.
  const rawDown = new Set<string>();
  const rawPressed = new Set<string>();

  let mouseDX = 0;
  let mouseDY = 0;
  let aiming = false;
  let firing = false;
  let pointerLocked = false;
  let movementLocked = false;

  const onKeyDown = (e: KeyboardEvent) => {
    // Tab would move focus out of the canvas; Space would scroll the page.
    // Arrows and PageUp/Down would scroll it too, and the grip tool uses them.
    if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow') || e.code.startsWith('Page')) {
      e.preventDefault();
    }
    if (e.repeat) return;

    if (!rawDown.has(e.code)) rawPressed.add(e.code);
    rawDown.add(e.code);

    const action = KEY_MAP[e.code];
    if (!action) return;
    if (!down.has(action)) pressedThisFrame.add(action);
    down.add(action);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    rawDown.delete(e.code);

    const action = KEY_MAP[e.code];
    if (!action) return;
    down.delete(action);
    releasedThisFrame.add(action);
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!pointerLocked) return;
    mouseDX += e.movementX;
    mouseDY += e.movementY;
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!pointerLocked) return;
    if (e.button === 0) firing = true;
    if (e.button === 2) aiming = true;
  };

  const onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) firing = false;
    if (e.button === 2) aiming = false;
  };

  const onPointerLockChange = () => {
    pointerLocked = document.pointerLockElement === canvas;
    if (!pointerLocked) {
      // Dropping the lock (Esc) must not leave keys stuck down.
      down.clear();
      rawDown.clear();
      aiming = false;
      firing = false;
    }
  };

  const onContextMenu = (e: Event) => e.preventDefault();
  const onBlur = () => {
    down.clear();
    rawDown.clear();
    aiming = false;
    firing = false;
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  canvas.addEventListener('contextmenu', onContextMenu);

  return {
    active: (a) => !(movementLocked && MOVEMENT_ACTIONS.has(a)) && down.has(a),
    pressed: (a) => !(movementLocked && MOVEMENT_ACTIONS.has(a)) && pressedThisFrame.has(a),
    released: (a) => releasedThisFrame.has(a),
    get mouseDX() {
      return mouseDX;
    },
    get mouseDY() {
      return mouseDY;
    },
    get aiming() {
      return aiming;
    },
    get firing() {
      return firing;
    },
    get pointerLocked() {
      return pointerLocked;
    },
    get keysDown() {
      return rawDown;
    },
    pressedRaw: (code) => rawPressed.has(code),
    setMovementLocked(locked) {
      movementLocked = locked;
    },
    endFrame() {
      pressedThisFrame.clear();
      releasedThisFrame.clear();
      rawPressed.clear();
      mouseDX = 0;
      mouseDY = 0;
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
