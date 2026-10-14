import * as THREE from 'three';

/** Structured, serialisable description of a loaded glTF model. */
export interface ModelStats {
  name: string;
  url: string;
  /** Number of Mesh / SkinnedMesh objects in the hierarchy. */
  meshes: number;
  primitives: number;
  triangles: number;
  vertices: number;
  skinnedMeshes: number;
  materials: string[];
  textures: number;
  /** World-space AABB in the model's own units. */
  bbox: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
    center: [number, number, number];
  };
  bones: string[];
  boneCount: number;
  animations: { name: string; duration: number; tracks: number }[];
  /** Names of the direct children of the glTF scene root. */
  rootNodes: string[];
  /** Names of the top-level objects inside the glTF scene (Sketchfab wrappers etc). */
  hierarchy: string[];
  /** True when the model contains a skeleton with legs+spine (i.e. a real character). */
  looksLikeFullBodyCharacter: boolean;
}

const HUMAN_LEG = ['upleg', 'thigh', 'foot', 'toe', 'leg'];
const HUMAN_SPINE = ['spine', 'hips', 'pelvis'];

/**
 * Walks a loaded glTF scene and produces a full report: geometry counts,
 * world-space bounds, skeleton, and animation clips.
 */
export function analyzeModel(root: THREE.Object3D, name: string, url = ''): ModelStats {
  let meshes = 0;
  let primitives = 0;
  let triangles = 0;
  let vertices = 0;
  let skinnedMeshes = 0;
  const materials = new Set<string>();
  const textures = new Set<THREE.Texture>();

  root.updateWorldMatrix(true, true);

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
    meshes++;

    const geo = mesh.geometry as THREE.BufferGeometry | undefined;
    if (geo) {
      const pos = geo.getAttribute('position');
      if (pos) vertices += pos.count;
      const index = geo.getIndex();
      triangles += index ? index.count / 3 : pos ? pos.count / 3 : 0;
    }

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      primitives++;
      materials.add(m.name || m.type);
      for (const key of Object.keys(m) as (keyof THREE.Material)[]) {
        const value = (m as unknown as Record<string, unknown>)[key as string];
        if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
      }
    }

    if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) skinnedMeshes++;
  });

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Skeleton: collect every Bone in the hierarchy.
  const bones: string[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) bones.push(obj.name);
  });

  // Animation clips live on the glTF parser output, not the scene graph.
  const gltf = root.userData.gltf as { animations?: THREE.AnimationClip[] } | undefined;
  const animations = (gltf?.animations ?? []).map((clip) => ({
    name: clip.name,
    duration: clip.duration,
    tracks: clip.tracks.length,
  }));

  const lower = bones.map((b) => b.toLowerCase());
  const hasLegs = lower.some((b) => HUMAN_LEG.some((k) => b.includes(k)));
  const hasSpine = lower.some((b) => HUMAN_SPINE.some((k) => b.includes(k))) || bones.length > 40;

  return {
    name,
    url,
    meshes,
    primitives,
    triangles: Math.round(triangles),
    vertices,
    skinnedMeshes,
    materials: [...materials],
    textures: textures.size,
    bbox: {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      size: [size.x, size.y, size.z],
      center: [center.x, center.y, center.z],
    },
    bones,
    boneCount: bones.length,
    animations,
    rootNodes: root.children.map((c) => c.name),
    hierarchy: root.children.map((c) => describeTree(c, 2)),
    looksLikeFullBodyCharacter: hasLegs && hasSpine,
  };
}

function describeTree(obj: THREE.Object3D, depth: number): string {
  const kids = depth > 0 ? obj.children.map((c) => describeTree(c, depth - 1)) : [];
  return kids.length ? `${obj.name}(${obj.type})[${kids.join(', ')}]` : `${obj.name}(${obj.type})`;
}

/** Human-readable multi-line report, mirroring what gets logged to the console. */
export function formatStats(s: ModelStats): string {
  const f = (n: number, d = 3) => n.toFixed(d);
  const lines = [
    `── ${s.name} ──────────────────────────────────────────────`,
    `  url:            ${s.url}`,
    `  meshes:         ${s.meshes}  (skinned: ${s.skinnedMeshes}, primitives: ${s.primitives})`,
    `  triangles:      ${s.triangles.toLocaleString('en-US')}`,
    `  vertices:       ${s.vertices.toLocaleString('en-US')}`,
    `  materials:      ${s.materials.join(', ') || '(none)'}`,
    `  textures:       ${s.textures}`,
    `  bbox min:       [${s.bbox.min.map((v) => f(v)).join(', ')}]`,
    `  bbox max:       [${s.bbox.max.map((v) => f(v)).join(', ')}]`,
    `  size WxHxD:     ${s.bbox.size.map((v) => f(v)).join(' x ')}`,
    `  center:         [${s.bbox.center.map((v) => f(v)).join(', ')}]`,
    `  bones:          ${s.boneCount}`,
    `  animations:     ${s.animations.length ? s.animations.map((a) => `${a.name} (${a.duration.toFixed(2)}s)`).join(', ') : '(none)'}`,
    `  full-body rig:  ${s.looksLikeFullBodyCharacter ? 'YES' : 'NO'}`,
  ];
  return lines.join('\n');
}
