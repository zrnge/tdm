/**
 * Shot effects: muzzle flash, tracers, impact decals, sparks and dust.
 *
 * Everything here is pooled and instanced. A 4v4 with two automatic weapons
 * produces a lot of transient geometry, and allocating a mesh per shot would
 * hand the garbage collector a job it cannot keep up with at 600 rpm.
 *
 *   - Muzzle flash: one pooled PointLight plus one pooled sprite. Only the
 *     most recent flash is lit, which is all the eye can resolve anyway. The
 *     light is NEVER hidden, only dimmed to zero: three.js leaves invisible
 *     lights out of its light count, so toggling `visible` changed the count on
 *     every shot and forced every lit material to re-resolve its shader — a
 *     ~0.5 s compile stall on the first shot and a hitch on every one after.
 *   - Tracers: a fixed pool of thin stretched boxes, recycled oldest-first.
 *   - Decals: a fixed pool of flat quads laid on the surface along the hit
 *     normal, recycled oldest-first and faded. Not DecalGeometry: that clips
 *     every triangle of the struck mesh on the CPU, and the warehouse walls are
 *     one 10k-triangle mesh, so each wall hit cost 50-60 ms.
 *   - Particles: one Points cloud per surface type, recycled.
 */
import * as THREE from 'three';
import type { HitResult } from '../combat/combat';

export interface Effects {
  /** A shot left the muzzle. */
  muzzleFlash(at: THREE.Vector3, dir: THREE.Vector3): void;
  /** Draw a tracer from `from` to `to`. */
  tracer(from: THREE.Vector3, to: THREE.Vector3): void;
  /** Spawn the impact effect for a resolved hit. */
  impact(hit: HitResult): void;
  /** A character took damage: a small blood puff at the impact. */
  blood(at: THREE.Vector3, dir: THREE.Vector3): void;
  update(dt: number): void;
  /**
   * Compiles the effect shaders up front. `compile` should be
   * `() => renderer.compile(scene, camera)`; the hidden pooled meshes are shown
   * for the duration so the first shot does not stall on a shader compile.
   */
  warmup(compile: () => void): void;
  dispose(): void;
}

const TRACER_COUNT = 24;
const TRACER_LIFE = 0.055;
const DECAL_COUNT = 48;
const DECAL_LIFE = 14;
/** Bullet-hole diameter per surface, metres: a rifle round chips wood and concrete wider than steel. */
const HOLE_SIZE = { metal: 0.055, concrete: 0.075, wood: 0.08 } as const;

type DecalSurface = keyof typeof HOLE_SIZE;
const PARTICLE_COUNT = 220;
const PARTICLE_LIFE = 0.7;

export function createEffects(scene: THREE.Scene): Effects {
  const root = new THREE.Group();
  root.name = 'effects';
  scene.add(root);

  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  // ---- muzzle flash ----
  // Always visible, idle at intensity 0. See the module comment.
  const flashLight = new THREE.PointLight(0xffd9a0, 0, 12, 2);
  root.add(flashLight);

  const flashGeo = new THREE.SphereGeometry(0.09, 8, 6);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffe6b0,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const flashMesh = new THREE.Mesh(flashGeo, flashMat);
  flashMesh.visible = false;
  root.add(flashMesh);
  disposables.push(flashGeo, flashMat);
  let flashTimer = 0;

  // ---- tracers ----
  // A thin box stretched along Z, scaled per shot. Additive so overlapping
  // tracers brighten rather than z-fight.
  const tracerGeo = new THREE.BoxGeometry(0.022, 0.022, 1);
  tracerGeo.translate(0, 0, -0.5); // origin at the muzzle end
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xffcf7a,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const tracers = new THREE.InstancedMesh(tracerGeo, tracerMat, TRACER_COUNT);
  tracers.name = 'tracers';
  tracers.frustumCulled = false;
  tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(tracers);
  disposables.push(tracerGeo, tracerMat);

  const tracerLife = new Float32Array(TRACER_COUNT);
  let tracerCursor = 0;
  const dummy = new THREE.Object3D();
  const hideMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  // ---- decals ----
  // Built lazily on the first impact (or by `warmup`), because the texture is
  // generated on a canvas. Each slot has its own material so it can fade alone;
  // they all share one shader program.
  interface Decal {
    mesh: THREE.Mesh;
    material: THREE.MeshStandardMaterial;
    life: number;
  }
  const decals: Decal[] = [];
  let decalCursor = 0;
  /** The quad's own facing axis, turned onto the hit normal. */
  const FORWARD = new THREE.Vector3(0, 0, 1);
  const UP_AXIS = new THREE.Vector3(0, 1, 0);
  const decalX = new THREE.Vector3();
  const decalY = new THREE.Vector3();
  const decalBasis = new THREE.Matrix4();

  // ---- particles ----
  const particlePos = new Float32Array(PARTICLE_COUNT * 3);
  const particleVel = new Float32Array(PARTICLE_COUNT * 3);
  const particleLife = new Float32Array(PARTICLE_COUNT);
  const particleColor = new Float32Array(PARTICLE_COUNT * 3);
  let particleCursor = 0;

  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
  particleGeo.setAttribute('color', new THREE.BufferAttribute(particleColor, 3));
  // A soft round dot: untextured points render as hard squares, which up close
  // read as confetti rather than sparks and dust.
  const dotCanvas = document.createElement('canvas');
  dotCanvas.width = dotCanvas.height = 32;
  const dotCtx = dotCanvas.getContext('2d')!;
  const dotGrad = dotCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
  dotGrad.addColorStop(0, 'rgba(255,255,255,1)');
  dotGrad.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  dotGrad.addColorStop(1, 'rgba(255,255,255,0)');
  dotCtx.fillStyle = dotGrad;
  dotCtx.fillRect(0, 0, 32, 32);
  const dotTex = new THREE.CanvasTexture(dotCanvas);
  disposables.push(dotTex);
  const particleMat = new THREE.PointsMaterial({
    map: dotTex,
    size: 0.04,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const particles = new THREE.Points(particleGeo, particleMat);
  particles.name = 'impact-particles';
  particles.frustumCulled = false;
  root.add(particles);
  disposables.push(particleGeo, particleMat);
  // Park every particle at the origin so nothing renders before first use.
  for (let i = 0; i < PARTICLE_COUNT; i++) particleLife[i] = 0;

  function spawnParticle(
    at: THREE.Vector3,
    dir: THREE.Vector3,
    spread: number,
    speed: number,
    color: THREE.Color
  ) {
    const i = particleCursor;
    particleCursor = (particleCursor + 1) % PARTICLE_COUNT;
    particlePos[i * 3] = at.x;
    particlePos[i * 3 + 1] = at.y;
    particlePos[i * 3 + 2] = at.z;
    particleVel[i * 3] = dir.x * speed + (Math.random() * 2 - 1) * spread;
    particleVel[i * 3 + 1] = dir.y * speed + (Math.random() * 2 - 1) * spread + 0.6;
    particleVel[i * 3 + 2] = dir.z * speed + (Math.random() * 2 - 1) * spread;
    particleColor[i * 3] = color.r;
    particleColor[i * 3 + 1] = color.g;
    particleColor[i * 3 + 2] = color.b;
    particleLife[i] = PARTICLE_LIFE;
  }

  const SPARK = new THREE.Color(0xffc46b);
  const DUST = new THREE.Color(0xbdb4a4);
  const SPLINTER = new THREE.Color(0xc79a5e);
  const BLOOD = new THREE.Color(0xb02020);

  /**
   * Bullet-hole textures, generated once per surface: three variants each.
   *
   * Declared here, ABOVE the `return`, because they are used from the returned
   * object. A `let` binding is not hoisted the way a `function` declaration is:
   * leaving it below the return would put it in the temporal dead zone and
   * throw on the first shot.
   */
  let holeTextures: Record<DecalSurface, THREE.CanvasTexture[]> | null = null;
  function holeTexture(surface: DecalSurface): THREE.CanvasTexture {
    if (!holeTextures) {
      holeTextures = { metal: [], concrete: [], wood: [] };
      for (const kind of ['metal', 'concrete', 'wood'] as DecalSurface[]) {
        for (let v = 0; v < 3; v++) {
          const tex = new THREE.CanvasTexture(drawBulletHole(kind));
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          disposables.push(tex);
          holeTextures[kind].push(tex);
        }
      }
    }
    const list = holeTextures[surface];
    return list[Math.floor(Math.random() * list.length)];
  }

  return {
    muzzleFlash(at, dir) {
      flashLight.position.copy(at);
      flashLight.intensity = 26;
      flashMesh.position.copy(at).addScaledVector(dir, 0.06);
      flashMesh.visible = true;
      flashTimer = 0.045;
    },

    tracer(from, to) {
      const i = tracerCursor;
      tracerCursor = (tracerCursor + 1) % TRACER_COUNT;

      const length = from.distanceTo(to);
      if (length < 1e-3) return;

      dummy.position.copy(from);
      dummy.lookAt(to);
      // lookAt points -Z at the target, which is the direction the box extends.
      dummy.scale.set(1, 1, length);
      dummy.updateMatrix();
      tracers.setMatrixAt(i, dummy.matrix);
      tracerLife[i] = TRACER_LIFE;
      tracers.instanceMatrix.needsUpdate = true;
    },

    impact(hit) {
      const dir = hit.normal.clone();

      if (hit.target) {
        this.blood(hit.point, dir);
        return;
      }

      switch (hit.surface) {
        case 'metal':
          for (let i = 0; i < 7; i++) spawnParticle(hit.point, dir, 1.6, 2.4, SPARK);
          break;
        case 'wood':
          for (let i = 0; i < 8; i++) spawnParticle(hit.point, dir, 1.1, 1.4, SPLINTER);
          break;
        default:
          for (let i = 0; i < 9; i++) spawnParticle(hit.point, dir, 0.9, 1.0, DUST);
          break;
      }

      addDecal(hit);
    },

    blood(at, dir) {
      for (let i = 0; i < 6; i++) spawnParticle(at, dir, 1.0, 1.6, BLOOD);
    },

    update(dt) {
      // ---- muzzle flash ----
      if (flashTimer > 0) {
        flashTimer -= dt;
        const k = Math.max(flashTimer / 0.045, 0);
        flashLight.intensity = 26 * k;
        flashMat.opacity = 0.95 * k;
        if (flashTimer <= 0) {
          flashLight.intensity = 0;
          flashMesh.visible = false;
        }
      }

      // ---- tracers ----
      let tracerDirty = false;
      for (let i = 0; i < TRACER_COUNT; i++) {
        if (tracerLife[i] <= 0) continue;
        tracerLife[i] -= dt;
        if (tracerLife[i] <= 0) {
          tracers.setMatrixAt(i, hideMatrix);
          tracerDirty = true;
        }
      }
      if (tracerDirty) tracers.instanceMatrix.needsUpdate = true;

      // ---- decals ----
      for (const d of decals) {
        if (d.life <= 0) continue;
        d.life -= dt;
        if (d.life <= 0) d.mesh.visible = false;
        else if (d.life < 2) d.material.opacity = d.life / 2;
      }

      // ---- particles ----
      let particleDirty = false;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        if (particleLife[i] <= 0) continue;
        particleLife[i] -= dt;
        particleDirty = true;
        if (particleLife[i] <= 0) {
          // Park it far below the world rather than at the origin, so a dead
          // particle can never be mistaken for a live one at floor level.
          particlePos[i * 3 + 1] = -1000;
          continue;
        }
        particleVel[i * 3 + 1] -= 9 * dt;
        particlePos[i * 3] += particleVel[i * 3] * dt;
        particlePos[i * 3 + 1] += particleVel[i * 3 + 1] * dt;
        particlePos[i * 3 + 2] += particleVel[i * 3 + 2] * dt;
      }
      if (particleDirty) {
        particleGeo.getAttribute('position').needsUpdate = true;
        particleGeo.getAttribute('color').needsUpdate = true;
      }
    },

    warmup(compile) {
      const pool = decalPool();
      flashMesh.visible = true;
      pool[0].mesh.visible = true;
      compile();
      flashMesh.visible = false;
      pool[0].mesh.visible = false;
    },

    dispose() {
      for (const d of decals) d.material.dispose();
      decals.length = 0;
      for (const d of disposables) d.dispose();
      root.removeFromParent();
    },
  };

  // -------------------------------------------------------------------------
  // Decals
  // -------------------------------------------------------------------------

  /** The decal pool, created on first use. */
  function decalPool(): Decal[] {
    if (decals.length) return decals;
    // A unit quad, scaled per hit to the surface's hole size.
    const geometry = new THREE.PlaneGeometry(1, 1);
    disposables.push(geometry);
    const map = holeTexture('metal');
    for (let i = 0; i < DECAL_COUNT; i++) {
      // Lit, so a hole in a dark corner is dark and one under a lamp is not;
      // an unlit mark reads as a black sticker.
      const material = new THREE.MeshStandardMaterial({
        map,
        roughness: 0.85,
        metalness: 0,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 2;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
      decals.push({ mesh, material, life: 0 });
    }
    return decals;
  }

  /**
   * Lays a bullet mark flat on the surface that was hit, facing out along the
   * impact normal and spun randomly so repeated hits do not look stamped.
   *
   * A flat quad rather than a projected `DecalGeometry`: a mark this small
   * almost never straddles a corner, and the projection cost 50-60 ms per hit on
   * the warehouse walls. It also works on the instanced cover props, which the
   * projection could not handle.
   *
   * The pool is fixed at DECAL_COUNT; the oldest mark is reused first, which is
   * invisible in practice because the player has moved on by then.
   */
  function addDecal(hit: HitResult) {
    if (hit.surface === 'flesh') return;
    const surface: DecalSurface = hit.surface;
    const pool = decalPool();
    const d = pool[decalCursor];
    decalCursor = (decalCursor + 1) % pool.length;

    const m = d.mesh;
    if (surface === 'wood') {
      // Splinters run along the grain, which is horizontal on these crates:
      // lay the texture's X axis level instead of spinning it at random.
      const n = hit.normal;
      decalX.crossVectors(UP_AXIS, n);
      if (decalX.lengthSq() < 1e-4) decalX.set(1, 0, 0);
      decalX.normalize();
      decalY.crossVectors(n, decalX);
      decalBasis.makeBasis(decalX, decalY, n);
      m.quaternion.setFromRotationMatrix(decalBasis);
      m.rotateZ((Math.random() - 0.5) * 0.3);
    } else {
      m.quaternion.setFromUnitVectors(FORWARD, hit.normal);
      m.rotateZ(Math.random() * Math.PI * 2);
    }
    const size = HOLE_SIZE[surface] * THREE.MathUtils.randFloat(0.85, 1.15);
    m.scale.set(size, size, 1);
    m.position.copy(hit.point).addScaledVector(hit.normal, 0.003);
    m.updateMatrix();
    m.visible = true;

    const mat = d.material;
    mat.map = holeTexture(surface);
    // The scraped ring on steel is bare metal and should catch the light.
    mat.metalness = surface === 'metal' ? 0.55 : 0;
    mat.roughness = surface === 'metal' ? 0.45 : 0.9;
    mat.opacity = 1;
    d.life = DECAL_LIFE;
  }
}

// ---------------------------------------------------------------------------
// Bullet-hole drawing
// ---------------------------------------------------------------------------

const HOLE_PX = 128;

/** A closed ragged outline around (cx, cy): radius `r` with per-vertex jitter, stretched in X by `sx`. */
function raggedPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, jitter: number, sx = 1, steps = 22) {
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const rr = r * (1 - jitter / 2 + Math.random() * jitter);
    const x = cx + Math.cos(a) * rr * sx;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** A crooked stroke from radius `r0` out to `r1` along angle `a`, about the centre `c`. */
function crackPath(ctx: CanvasRenderingContext2D, c: number, a: number, r0: number, r1: number) {
  ctx.beginPath();
  ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
  const segments = 4;
  for (let i = 1; i <= segments; i++) {
    const r = r0 + ((r1 - r0) * i) / segments;
    const aa = a + (Math.random() - 0.5) * 0.35;
    ctx.lineTo(c + Math.cos(aa) * r, c + Math.sin(aa) * r);
  }
  ctx.stroke();
}

/** Paints one bullet-hole variant for `kind` onto a fresh transparent canvas. */
function drawBulletHole(kind: DecalSurface): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = HOLE_PX;
  const ctx = canvas.getContext('2d')!;
  const c = HOLE_PX / 2;
  const R = HOLE_PX / 2;
  ctx.lineCap = 'round';

  if (kind === 'metal') {
    // Paint blown off around the impact, showing bright bare steel.
    raggedPath(ctx, c, c, R * 0.5, 0.25);
    ctx.fillStyle = 'rgba(182, 178, 170, 0.95)';
    ctx.fill();
    // Scuffs radiating out of the strike.
    ctx.strokeStyle = 'rgba(205, 200, 192, 0.55)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) crackPath(ctx, c, Math.random() * Math.PI * 2, R * 0.25, R * (0.55 + Math.random() * 0.25));
    // Scorch around the hole.
    const scorch = ctx.createRadialGradient(c, c, R * 0.12, c, c, R * 0.42);
    scorch.addColorStop(0, 'rgba(35, 30, 26, 0.95)');
    scorch.addColorStop(1, 'rgba(35, 30, 26, 0)');
    ctx.fillStyle = scorch;
    ctx.fillRect(0, 0, HOLE_PX, HOLE_PX);
    // The hole, with a lip of pushed-in metal catching the light.
    raggedPath(ctx, c, c, R * 0.17, 0.12);
    ctx.fillStyle = '#060504';
    ctx.fill();
    ctx.strokeStyle = 'rgba(225, 220, 210, 0.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
  } else if (kind === 'concrete') {
    // Chipped crater of fresh, paler concrete with a ragged rim.
    raggedPath(ctx, c, c, R * 0.6, 0.4, 1, 28);
    ctx.fillStyle = 'rgba(158, 153, 145, 0.95)';
    ctx.fill();
    const crater = ctx.createRadialGradient(c, c, 0, c, c, R * 0.48);
    crater.addColorStop(0, 'rgba(48, 45, 42, 0.95)');
    crater.addColorStop(1, 'rgba(48, 45, 42, 0)');
    ctx.fillStyle = crater;
    ctx.fillRect(0, 0, HOLE_PX, HOLE_PX);
    // Hairline cracks running out past the crater.
    ctx.strokeStyle = 'rgba(30, 28, 26, 0.75)';
    ctx.lineWidth = 1.4;
    const cracks = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < cracks; i++) crackPath(ctx, c, Math.random() * Math.PI * 2, R * 0.15, R * (0.7 + Math.random() * 0.25));
    raggedPath(ctx, c, c, R * 0.12, 0.3);
    ctx.fillStyle = '#0a0908';
    ctx.fill();
  } else {
    // Raw pale wood torn out along the grain (texture X is the grain).
    raggedPath(ctx, c, c, R * 0.42, 0.45, 1.7, 26);
    ctx.fillStyle = 'rgba(224, 192, 142, 0.95)';
    ctx.fill();
    // Splinters: long thin streaks along the grain, light and dark.
    for (let i = 0; i < 14; i++) {
      const y = c + (Math.random() - 0.5) * R * 0.55;
      const len = R * (0.35 + Math.random() * 0.55);
      const dir = Math.random() < 0.5 ? -1 : 1;
      ctx.strokeStyle = Math.random() < 0.6 ? 'rgba(242, 218, 175, 0.9)' : 'rgba(112, 78, 46, 0.8)';
      ctx.lineWidth = 1 + Math.random() * 1.5;
      ctx.beginPath();
      ctx.moveTo(c + dir * R * 0.1, y);
      ctx.lineTo(c + dir * len, y + (Math.random() - 0.5) * 4);
      ctx.stroke();
    }
    const torn = ctx.createRadialGradient(c, c, R * 0.08, c, c, R * 0.3);
    torn.addColorStop(0, 'rgba(60, 38, 20, 0.9)');
    torn.addColorStop(1, 'rgba(60, 38, 20, 0)');
    ctx.fillStyle = torn;
    ctx.fillRect(0, 0, HOLE_PX, HOLE_PX);
    raggedPath(ctx, c, c, R * 0.13, 0.35);
    ctx.fillStyle = '#120c07';
    ctx.fill();
  }
  return canvas;
}
