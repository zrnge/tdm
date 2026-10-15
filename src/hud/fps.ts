/**
 * Frame-rate counter in the top-left corner.
 *
 * Counts real browser frames on its own requestAnimationFrame loop rather than
 * hooking the game update, so it keeps reporting while the game is paused and
 * cannot be skewed by anything the update loop skips. The figure is averaged
 * over half a second, with the worst frame of that window alongside it — a
 * steady 60 with a 40 ms spike is a stutter, and the average alone hides it.
 */
export function createFpsCounter(): void {
  const el = document.createElement('div');
  el.className = 'fps';
  document.body.appendChild(el);

  let frames = 0;
  let windowStart = performance.now();
  let last = windowStart;
  let worst = 0;

  const tick = (now: number) => {
    frames++;
    worst = Math.max(worst, now - last);
    last = now;
    const elapsed = now - windowStart;
    if (elapsed >= 500) {
      const fps = Math.round((frames * 1000) / elapsed);
      el.textContent = `${fps} FPS · ${worst.toFixed(0)} ms max`;
      el.classList.toggle('fps--low', fps < 50);
      frames = 0;
      worst = 0;
      windowStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
