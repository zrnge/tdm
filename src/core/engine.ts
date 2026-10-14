/**
 * Renderer, scene, camera, and the frame loop plumbing.
 *
 * Colour pipeline matches the brief: ACES Filmic tone mapping, sRGB output,
 * PCF soft shadows. Post-processing is added in Phase 4 and will slot in front
 * of `render()` without changing callers.
 *
 * ## The overlay pass
 *
 * There is exactly ONE world scene. The first-person viewmodel is drawn by a
 * second camera into a second scene that is composited over the world with the
 * depth buffer cleared in between (`setOverlay`). This is the standard
 * first-person-weapon technique and it is what makes the weapon unable to clip
 * into a wall: the weapon is drawn after the world, with no depth test against
 * it, so no amount of geometry between the eye and the barrel can cut through
 * it. The alternative — parenting the weapon to the world camera and giving it
 * a tiny near plane — fails as soon as the player stands against a container.
 */
import * as THREE from 'three';
import { CAMERA, RENDER } from '../config';

export interface Engine {
  readonly renderer: THREE.WebGLRenderer;
  /** The single world scene: level, cover, bots, effects. */
  readonly scene: THREE.Scene;
  /** The world camera. In first person this sits at the player's eye. */
  readonly camera: THREE.PerspectiveCamera;
  /** Seconds since the previous frame, clamped to avoid huge first frames. */
  readonly delta: number;
  /** Seconds since the engine started. */
  readonly elapsed: number;
  /** Registers a per-frame callback. Returns an unsubscribe function. */
  onUpdate(fn: (dt: number, elapsed: number) => void): () => void;
  /**
   * Draws `scene` with `camera` on top of the world, with the depth buffer
   * cleared first. Pass null to remove the overlay. The first-person viewmodel
   * is the only user of this.
   */
  setOverlay(scene: THREE.Scene | null, camera: THREE.PerspectiveCamera | null): void;
  render(): void;
  dispose(): void;
}

export function createEngine(canvas: HTMLCanvasElement): Engine {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // Three.js 0.186 REMOVED PCFSoftShadowMap — it logs a warning and silently
  // falls back to PCFShadowMap. Use PCFShadowMap directly so the console stays
  // clean and the result is identical.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // The overlay pass needs to clear depth between the two draws, so automatic
  // clearing is turned off and done explicitly in `render()`.
  renderer.autoClear = false;

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    CAMERA.fov,
    window.innerWidth / window.innerHeight,
    CAMERA.near,
    CAMERA.far
  );
  camera.position.set(0, 1.6, 4);

  let overlayScene: THREE.Scene | null = null;
  let overlayCamera: THREE.PerspectiveCamera | null = null;

  const listeners = new Set<(dt: number, elapsed: number) => void>();

  let last = performance.now();
  let elapsed = 0;
  let delta = 0;
  let rafId = 0;
  let running = true;

  function render() {
    renderer.clear();
    renderer.render(scene, camera);
    if (overlayScene && overlayCamera) {
      // The weapon is drawn over the world with no depth test against it, so it
      // can never be cut through by a wall the player is standing against.
      renderer.clearDepth();
      renderer.render(overlayScene, overlayCamera);
    }
  }

  const tick = () => {
    rafId = requestAnimationFrame(tick);
    const now = performance.now();
    // Clamp: a background tab or a debugger pause must not teleport the player.
    delta = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += delta;

    for (const fn of listeners) fn(delta, elapsed);

    if (running) render();
  };

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (overlayCamera) {
      overlayCamera.aspect = w / h;
      overlayCamera.updateProjectionMatrix();
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER.maxPixelRatio));
    renderer.setSize(w, h, false);
  };
  window.addEventListener('resize', onResize);

  rafId = requestAnimationFrame(tick);

  return {
    renderer,
    scene,
    camera,
    get delta() {
      return delta;
    },
    get elapsed() {
      return elapsed;
    },
    onUpdate(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setOverlay(nextScene, nextCamera) {
      overlayScene = nextScene;
      overlayCamera = nextCamera;
      if (nextCamera) {
        nextCamera.aspect = window.innerWidth / window.innerHeight;
        nextCamera.updateProjectionMatrix();
      }
    },
    render,
    dispose() {
      running = false;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      listeners.clear();
      renderer.dispose();
    },
  };
}
