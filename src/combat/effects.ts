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
const DECAL_SIZE = 0.17;
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
    material: THREE.MeshBasicMaterial;
    life: number;
  }
  const decals: Decal[] = [];
  let decalCursor = 0;
  /** The quad's own facing axis, turned onto the hit normal. */
  const FORWARD = new THREE.Vector3(0, 0, 1);

  // ---- particles ----
  const particlePos = new Float32Array(PARTICLE_COUNT * 3);
  const particleVel = new Float32Array(PARTICLE_COUNT * 3);
  const particleLife = new Float32Array(PARTICLE_COUNT);
  const particleColor = new Float32Array(PARTICLE_COUNT * 3);
  let particleCursor = 0;

  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
  particleGeo.setAttribute('color', new THREE.BufferAttribute(particleColor, 3));
  const particleMat = new THREE.PointsMaterial({
    size: 0.055,
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
   * A soft radial scorch mark, generated once and shared by every decal.
   *
   * Declared here, ABOVE the `return`, because `decalTexture()` is called from
   * the returned object. A `let` binding is not hoisted the way a `function`
   * declaration is: leaving it below the return would put it in the temporal
   * dead zone and throw on the first shot.
   */
  let decalTex: THREE.CanvasTexture | null = null;
  function decalTexture(): THREE.CanvasTexture {
    if (decalTex) return decalTex;
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(12,10,9,0.95)');
    grad.addColorStop(0.45, 'rgba(20,17,15,0.7)');
    grad.addColorStop(1, 'rgba(30,26,22,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    decalTex = new THREE.CanvasTexture(canvas);
    decalTex.colorSpace = THREE.SRGBColorSpace;
    disposables.push(decalTex);
    return decalTex;
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
    const geometry = new THREE.PlaneGeometry(DECAL_SIZE, DECAL_SIZE);
    disposables.push(geometry);
    const map = decalTexture();
    for (let i = 0; i < DECAL_COUNT; i++) {
      const material = new THREE.MeshBasicMaterial({
        map,
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
    const pool = decalPool();
    const d = pool[decalCursor];
    decalCursor = (decalCursor + 1) % pool.length;

    const m = d.mesh;
    m.quaternion.setFromUnitVectors(FORWARD, hit.normal);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.position.copy(hit.point).addScaledVector(hit.normal, 0.004);
    m.updateMatrix();
    m.visible = true;
    d.material.opacity = 1;
    d.life = DECAL_LIFE;
  }
}
