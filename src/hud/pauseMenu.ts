/**
 * The pause menu, shown when the player presses Esc mid-game.
 *
 * Esc is the browser's own "release the pointer lock" key, so the game cannot
 * stop it from unlocking the mouse — it can only decide what to show when it
 * does. Before the first click that is the boot screen; after it, this menu.
 * The match is frozen while it is up (see the `paused` check in main.ts).
 *
 * Resuming needs a fresh pointer lock, which the browser only grants from a
 * click — never from a key press — so RESUME is a button. Chrome also refuses a
 * lock requested within about a second of the user pressing Esc; when that
 * happens the menu says so instead of silently doing nothing.
 */

export interface PauseMenu {
  show(): void;
  hide(): void;
  readonly visible: boolean;
  /** Tells the player a resume attempt was refused, so they click again. */
  resumeRefused(): void;
}

export interface PauseMenuOptions {
  onResume(): void;
  onSettings(): void;
  onCredits(): void;
  onQuit(): void;
}

export function createPauseMenu(opts: PauseMenuOptions): PauseMenu {
  const root = document.createElement('div');
  root.className = 'pause';
  root.style.display = 'none';

  const panel = document.createElement('div');
  panel.className = 'pause__panel';
  root.appendChild(panel);

  const title = document.createElement('h2');
  title.className = 'pause__title';
  title.textContent = 'PAUSED';
  panel.appendChild(title);

  const hint = document.createElement('p');
  hint.className = 'pause__hint';
  panel.appendChild(hint);

  const button = (label: string, onClick: () => void, ghost = true) => {
    const b = document.createElement('button');
    b.className = ghost ? 'boot__button boot__button--ghost pause__button' : 'boot__button pause__button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    panel.appendChild(b);
    return b;
  };

  const resume = button('RESUME', () => opts.onResume(), false);
  button('SETTINGS', () => opts.onSettings());
  button('CREDITS', () => opts.onCredits());
  button('QUIT TO MAIN MENU', () => opts.onQuit());

  document.body.appendChild(root);

  const defaultHint = 'The match is frozen.';

  return {
    show() {
      hint.textContent = defaultHint;
      hint.classList.remove('pause__hint--warn');
      root.style.display = 'grid';
      resume.focus();
    },
    hide() {
      root.style.display = 'none';
    },
    get visible() {
      return root.style.display !== 'none';
    },
    resumeRefused() {
      hint.textContent = 'The browser needs a moment after Esc — click RESUME again.';
      hint.classList.add('pause__hint--warn');
    },
  };
}
