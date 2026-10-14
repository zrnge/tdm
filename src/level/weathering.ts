/**
 * Procedural weathering for the cover props: rust, dirt and dust.
 *
 * The containers, crates and racks are plain boxes with flat colours, which
 * reads as a blockout rather than a warehouse. This patches their
 * `MeshStandardMaterial` shaders (via `onBeforeCompile`) to layer wear on top of
 * the base colour — no texture assets, no UVs needed, and still one draw call
 * per InstancedMesh.
 *
 * ## Layers, in the order they are applied
 *
 *   paint     low-frequency mottling, and a per-instance tint so no two props match
 *   detail    corrugated panels (container), planks + grain + stains (crate)
 *   rust      noise patches biased toward edges and the floor, plus drip streaks
 *             running down from the roof rail (metal only)
 *   grime     dark dirt creeping up from the floor, with a ragged top edge
 *   dust      pale film settled on upward-facing surfaces
 *
 * Rust and dust also drive roughness and metalness, so a rusted patch stops
 * reflecting the environment the way painted steel does.
 *
 * ## Cost
 *
 * The noise is BAKED, not evaluated per pixel. Live 3D fbm cost ~11 ms per frame
 * on an integrated GPU with a container filling the screen; instead one tiling
 * 256x256 RGBA texture is generated at load (four independent fbm channels) and
 * sampled a handful of times. Mipmaps also stop the pattern shimmering at range.
 *
 * ## Coordinates
 *
 * Patterns are glued to each prop: they are sampled from the prop's OWN space
 * (before the instance matrix), projected onto the face plane — every face of
 * these props is axis-aligned in that space, so one planar lookup per face is
 * exact. A per-instance seed hashed from the instance's translation offsets the
 * lookup, which is what makes each container different. Floor grime alone uses
 * world height, so a crate stacked on another stays clean.
 *
 * Surface relief (corrugation, plank seams) is bump-mapped from screen-space
 * derivatives of a height in metres — the same construction as three.js's own
 * `perturbNormalArb` — so no tangents are required. The relief fades out where
 * it would alias at distance.
 */
import * as THREE from 'three';

export type WeatherKind = 'container' | 'crate' | 'rack';

export interface WeatherOptions {
  kind: WeatherKind;
  /** Half-extents of the prop's main body in its own space, metres. */
  half: { x: number; y: number; z: number };
  /** Width of the edge-wear band, metres. */
  edgeWidth?: number;
  /** How high floor grime reaches, metres (ragged around this). */
  grimeHeight?: number;
}

const DEFINE: Record<WeatherKind, string> = {
  container: 'WEATHER_CONTAINER',
  crate: 'WEATHER_CRATE',
  rack: 'WEATHER_RACK',
};

/** Pale warehouse dust, in linear space. */
const DUST = new THREE.Color(0.3, 0.28, 0.25);

const VERTEX_DECL = /* glsl */ `
varying vec3 vWLocal;
varying vec3 vWLocalNormal;
varying vec3 vWWorldNormal;
varying float vWSeed;
varying float vWWorldY;
`;

const VERTEX_BODY = /* glsl */ `
vWLocal = transformed;
vWLocalNormal = objectNormal;
#ifdef USE_INSTANCING
  vWWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
  vWSeed = fract(sin(dot(instanceMatrix[3].xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  vWWorldY = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).y;
#else
  vWWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
  vWSeed = 0.0;
  vWWorldY = (modelMatrix * vec4(transformed, 1.0)).y;
#endif
`;

const FRAGMENT_DECL = /* glsl */ `
varying vec3 vWLocal;
varying vec3 vWLocalNormal;
varying vec3 vWWorldNormal;
varying float vWSeed;
varying float vWWorldY;
uniform vec3 uWHalf;
uniform vec3 uWDust;
uniform float uWEdgeWidth;
uniform float uWGrimeHeight;
// R: large mottling  G: rust patches  B: dust / stains  A: fine detail
uniform sampler2D uWNoise;

float wHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
// Bump from a height in metres, after three.js's perturbNormalArb.
vec3 wPerturb(vec3 surfPos, vec3 surfNorm, float h, float faceDir) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

/** Runs after `color_fragment`: computes every mask and repaints diffuseColor. */
const FRAGMENT_COLOR = /* glsl */ `
vec3 wLp = vWLocal;
vec3 wLn = normalize(vWLocalNormal);
// The face plane in prop space: every face of these props is axis-aligned.
vec2 wUV = abs(wLn.x) > 0.5 ? wLp.zy : (abs(wLn.y) > 0.5 ? wLp.xz : wLp.xy);
vec2 wOff = vWSeed * vec2(7.31, 3.17);
float wHeightAbove = max(vWWorldY, 0.0);

// Distance to the nearest box edge: the middle of the three face distances.
vec3 wDd = max(uWHalf - abs(wLp), 0.0);
float wMn = min(wDd.x, min(wDd.y, wDd.z));
float wMx = max(wDd.x, max(wDd.y, wDd.z));
float wMid = wDd.x + wDd.y + wDd.z - wMn - wMx;
float wEdge = 1.0 - smoothstep(0.0, uWEdgeWidth, wMid);

float wBig = texture2D(uWNoise, wUV * 0.15 + wOff).r;
float wDetail = texture2D(uWNoise, wUV * 1.1 + wOff * 1.7).a;
float wVertical = 1.0 - smoothstep(0.4, 0.7, abs(wLn.y));

float wGrime = 1.0 - smoothstep(0.0, uWGrimeHeight * (0.5 + 0.9 * wBig), wHeightAbove);
float wUp = smoothstep(0.5, 0.95, vWWorldNormal.y);
float wDust = wUp * smoothstep(0.3, 0.65, texture2D(uWNoise, wUV * 0.62 + wOff + 0.37).b);
float wRust = 0.0;
float wHeight = 0.0;

vec3 wBase = diffuseColor.rgb * mix(0.8, 1.12, wBig) * (0.9 + 0.2 * vWSeed);
vec3 wRustCol = mix(vec3(0.045, 0.018, 0.007), vec3(0.16, 0.06, 0.02), wDetail);

#if defined(WEATHER_CONTAINER) || defined(WEATHER_RACK)
  #ifdef WEATHER_CONTAINER
    float wRustLo = 0.64;
    float wStreakAmt = 0.6;
  #else
    float wRustLo = 0.68;
    float wStreakAmt = 0.0;
  #endif
  float wRustN = texture2D(uWNoise, wUV * 0.45 + wOff).g;
  wRust = smoothstep(wRustLo, wRustLo + 0.14, wRustN + wEdge * 0.16 + wGrime * 0.2 + vWSeed * 0.06);

  // Drips from the roof rail: noise stretched tall, strongest near the top.
  float wStreakN = texture2D(uWNoise, vec2(wUV.x * 1.75, wLp.y * 0.09) + wOff).r;
  float wTop = smoothstep(-uWHalf.y, uWHalf.y, wLp.y);
  float wStreak = smoothstep(0.58, 0.8, wStreakN) * wTop * wVertical * wStreakAmt;

  wBase = mix(wBase, wRustCol * 0.9, wStreak);
  wBase = mix(wBase, wRustCol, wRust);
  wRust = max(wRust, wStreak * 0.6);
#endif

#ifdef WEATHER_CONTAINER
  // Corrugated panels: trapezoid ribs across the long sides and the ends,
  // kept off the rails and corner posts.
  float wU = wUV.x;
  float wRib = smoothstep(0.3, 0.7, abs(fract(wU / 0.28) - 0.5) * 2.0) * 0.03;
  // Soft edge: a hard cutoff makes the bump derivative spike into a bright seam.
  float wPanel = smoothstep(0.14, 0.26, wMid) * wVertical;
  float wFade = 1.0 - smoothstep(0.03, 0.1, fwidth(wU));
  wHeight = wRib * wPanel * wFade + wDetail * 0.0015 * wRust;
  // Ribs catch a little dirt in their valleys.
  wBase *= 1.0 - (0.03 - wRib) * 4.0 * wPanel * wFade;
#endif

#ifdef WEATHER_CRATE
  // Planks: horizontal on the sides, running along X on the lid.
  float wTopFace = step(0.5, abs(wLn.y));
  float wPc = mix(wLp.y, wLp.z, wTopFace);
  float wAlong = wUV.x;
  float wPlankH = 0.2;
  float wPIdx = floor((wPc + 10.0) / wPlankH);
  float wG = fract((wPc + 10.0) / wPlankH);
  float wSeamD = min(wG, 1.0 - wG) * wPlankH;
  float wSeamFade = 1.0 - smoothstep(0.004, 0.012, fwidth(wPc));
  float wSeam = (1.0 - smoothstep(0.0, 0.012, wSeamD)) * wSeamFade;
  float wTint = mix(0.75, 1.15, wHash(vec3(wPIdx, vWSeed * 91.0, 3.0)));
  float wGrain = texture2D(uWNoise, vec2(wAlong * 0.25, wPc * 7.5) + wPIdx * 0.37 + wOff).a;
  wBase *= wTint * mix(0.75, 1.15, wGrain);
  wBase *= 1.0 - wSeam * 0.65;
  float wStain = smoothstep(0.5, 0.75, texture2D(uWNoise, wUV * 0.33 + wOff + 0.61).b);
  wBase *= 1.0 - wStain * 0.45;
  // Old timber greys and darkens with age.
  wBase = mix(wBase, vec3(dot(wBase, vec3(0.33))) * 0.8, 0.3 + 0.2 * vWSeed);
  // Scuffed corners show paler raw wood.
  wBase = mix(wBase, wBase * 1.4 + vec3(0.03, 0.02, 0.01), wEdge * smoothstep(0.35, 0.7, wDetail));
  wHeight = -wSeam * 0.006;
#endif

wBase *= 1.0 - wGrime * 0.55 * (0.6 + 0.4 * wDetail);
wBase = mix(wBase, uWDust, wDust * 0.7);
wBase = mix(wBase, uWDust, 0.05);
diffuseColor.rgb = wBase;
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 0.95, max(wRust, wDust));
roughnessFactor = min(1.0, roughnessFactor + wGrime * 0.1);
`;

const FRAGMENT_METALNESS = /* glsl */ `
metalnessFactor *= (1.0 - max(wRust, wDust) * 0.9) * (1.0 - wGrime * 0.5);
`;

const FRAGMENT_NORMAL = /* glsl */ `
normal = wPerturb(-vViewPosition, normal, wHeight, faceDirection);
`;

/**
 * Patches `mat` in place to render weathered. Call once, before first render.
 * Materials of different kinds get different shader programs.
 */
export function applyWeathering(mat: THREE.MeshStandardMaterial, opts: WeatherOptions): void {
  const half = new THREE.Vector3(opts.half.x, opts.half.y, opts.half.z);
  const edgeWidth = opts.edgeWidth ?? 0.12;
  const grimeHeight = opts.grimeHeight ?? 0.6;
  const noise = noiseTexture();

  mat.defines = { ...(mat.defines ?? {}), [DEFINE[opts.kind]]: '' };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWHalf = { value: half };
    shader.uniforms.uWDust = { value: DUST };
    shader.uniforms.uWEdgeWidth = { value: edgeWidth };
    shader.uniforms.uWGrimeHeight = { value: grimeHeight };
    shader.uniforms.uWNoise = { value: noise };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_COLOR}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${FRAGMENT_ROUGHNESS}`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>\n${FRAGMENT_METALNESS}`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${FRAGMENT_NORMAL}`
      );
  };
  mat.customProgramCacheKey = () => `weathering-${opts.kind}`;
  mat.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Baked noise
// ---------------------------------------------------------------------------

let sharedNoise: THREE.DataTexture | null = null;

/**
 * A tiling 256x256 texture holding four independent 5-octave value-noise fbm
 * fields, one per channel. Built once and shared by every weathered material.
 * The lattice wraps at the tile edge, so the texture repeats seamlessly.
 */
function noiseTexture(): THREE.DataTexture {
  if (sharedNoise) return sharedNoise;
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  // Lattice cells across one tile for the first octave, per channel.
  const baseCells = [4, 4, 4, 8];

  const hash = (x: number, y: number, seed: number) => {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  };
  const valueNoise = (x: number, y: number, period: number, seed: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const x0 = xi % period;
    const y0 = yi % period;
    const x1 = (xi + 1) % period;
    const y1 = (yi + 1) % period;
    const a = hash(x0, y0, seed);
    const b = hash(x1, y0, seed);
    const c = hash(x0, y1, seed);
    const d = hash(x1, y1, seed);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      for (let ch = 0; ch < 4; ch++) {
        let amp = 0.5;
        let sum = 0;
        let cells = baseCells[ch];
        for (let o = 0; o < 5; o++) {
          sum += amp * valueNoise(u * cells, v * cells, cells, ch * 17 + o);
          cells *= 2;
          amp *= 0.5;
        }
        data[(j * size + i) * 4 + ch] = Math.round(sum * 255);
      }
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  sharedNoise = tex;
  return tex;
}
