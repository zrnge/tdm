/**
 * Procedural blockout humanoid.
 *
 * The supplied "ak74u" asset is a first-person viewmodel (arms + rifle), so it
 * cannot serve as the third-person character. This module builds a stand-in
 * humanoid in code instead.
 *
 * IMPORTANT — this is a deliberate interface match, not a throwaway:
 * the bone hierarchy uses Mixamo's standard names (`Hips`, `Spine`, `Spine1`,
 * `Neck`, `Head`, `LeftArm`, `LeftForeArm`, `LeftUpLeg`, ...). When a real
 * rigged character is dropped into `public/models/`, `createCharacterFromGLTF`
 * can swap in and every consumer (animation, headshot detection, team tinting)
 * keeps working unchanged. See `docs/MODEL-REPORT.md`.
 */
import * as THREE from 'three';
import { TEAM, type TeamId } from '../config';
import type { CharacterAnimator } from './animation';

export interface CharacterRig {
  /** Root object; add this to the scene and move it around. */
  root: THREE.Group;
  /** Bone lookup by Mixamo-standard name. */
  bones: Record<string, THREE.Object3D>;
  /** All meshes, for tinting and for raycast hit resolution. */
  meshes: THREE.Mesh[];
  /** Total height in metres, feet at y = 0. */
  height: number;
  /** Capsule radius that fits this body. */
  radius: number;
  /** The head bone, used for headshot detection. */
  headBone: THREE.Object3D;
  /** The character's rifle, once attached. Null when unarmed. */
  rifle?: THREE.Mesh | null;
  /** Clip-driven animation. Absent on the blockout, which has no clips. */
  animator?: CharacterAnimator | null;
  /**
   * Writes the world-space muzzle position into `out` and returns true, or
   * returns false when the rig has no known muzzle. Visual only: shots are
   * still traced from the eye.
   */
  muzzleWorld?(out: THREE.Vector3): boolean;
  dispose(): void;
}

/** Body proportions in metres, for a 1.8 m figure. */
const P = {
  height: 1.8,
  /** Hip joint height. Leg length (thigh + shin) must be hipHeight - ankle. */
  hipHeight: 0.87,
  /** Vertical distance from each joint to the next. These four, plus the head
   *  diameter, sum to exactly 1.80 m from feet to crown:
   *  0.87 + 0.13 + 0.23 + 0.27 + 0.07 + 0.23 = 1.80 */
  hipsToSpine: 0.13,
  spineToSpine1: 0.23,
  spine1ToNeck: 0.27,
  neckLength: 0.07,
  headSize: 0.23,
  shoulderWidth: 0.19,
  upperArm: 0.29,
  foreArm: 0.26,
  /** Thigh + shin = 0.76, so with the hip joint at 0.82 the ankle lands at
   *  0.06 m and the foot block's underside rests exactly on y = 0. */
  thigh: 0.4,
  shin: 0.36,
  footHeight: 0.08,
  /** Capsule radii. Arms are thinner than legs, as on a real body. */
  armRadius: 0.055,
  legRadius: 0.075,
  /** Torso block dimensions. */
  torsoWidth: 0.36,
  torsoDepth: 0.22,
  /** Half-distance between the two hip joints. Must exceed legRadius or the
   *  legs visually merge into a single column. */
  hipSpacing: 0.105,
} as const;

export function createCharacterRig(team: TeamId): CharacterRig {
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const meshes: THREE.Mesh[] = [];
  const bones: Record<string, THREE.Object3D> = {};

  const tint = TEAM[team].accent;
  const tintDark = TEAM[team].accentDark;

  // Shared geometries/materials, disposed together at the end of the session.
  const armGeo = new THREE.CapsuleGeometry(P.armRadius, 1, 4, 8);
  const legGeo = new THREE.CapsuleGeometry(P.legRadius, 1, 4, 8);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const sphereGeo = new THREE.SphereGeometry(P.headSize / 2, 16, 12);
  disposables.push(armGeo, legGeo, boxGeo, sphereGeo);

  // Two materials per team: a neutral one for the body and a team-accent one
  // for the armour so teams read at a glance. Both are PBR.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x3a4048,
    roughness: 0.78,
    metalness: 0.05,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.45,
    metalness: 0.15,
    emissive: tint,
    emissiveIntensity: 0.12,
  });
  const darkAccentMat = new THREE.MeshStandardMaterial({
    color: tintDark,
    roughness: 0.55,
    metalness: 0.2,
  });
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x0b0e12,
    roughness: 0.15,
    metalness: 0.7,
  });
  disposables.push(bodyMat, accentMat, darkAccentMat, visorMat);

  /** Creates a bone Object3D and registers it under its Mixamo name. */
  const bone = (name: string, parent: THREE.Object3D, y: number): THREE.Object3D => {
    const b = new THREE.Object3D();
    b.name = name;
    b.position.y = y;
    parent.add(b);
    bones[name] = b;
    return b;
  };

  /** Adds a mesh parented to a bone, offset so it hangs below the joint. */
  const part = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    opts: { y?: number; z?: number; x?: number; sx?: number; sy?: number; sz?: number; axis?: 'y' | 'z' }
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(opts.x ?? 0, opts.y ?? 0, opts.z ?? 0);
    if (opts.axis === 'z') mesh.rotation.x = Math.PI / 2;
    mesh.scale.set(opts.sx ?? 1, opts.sy ?? 1, opts.sz ?? 1);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The body is driven by bones, so its bind-pose bounds are unreliable.
    mesh.frustumCulled = false;
    parent.add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  // ---------------------------------------------------------------- hierarchy
  //   root -> Hips -> Spine -> Spine1 -> Neck -> Head
  //                              |-> LeftShoulder -> LeftArm -> LeftForeArm -> LeftHand
  //                              |-> RightShoulder -> ...
  //           |-> LeftUpLeg -> LeftLeg -> LeftFoot
  //           |-> RightUpLeg -> RightLeg -> RightFoot

  const root = new THREE.Group();
  root.name = `character-${team}`;

  const hips = bone('Hips', root, P.hipHeight);

  // Pelvis block. Widened to cover both hip joints.
  part(hips, boxGeo, accentMat, { y: 0.04, sx: P.hipSpacing * 2 + 0.10, sy: 0.18, sz: P.torsoDepth * 0.92 });

  const spine = bone('Spine', hips, P.hipsToSpine);
  part(spine, boxGeo, bodyMat, { y: 0.12, sx: P.torsoWidth, sy: 0.28, sz: P.torsoDepth });

  const spine1 = bone('Spine1', spine, P.spineToSpine1);
  // Chest plate in team colour — the main readability cue at range.
  part(spine1, boxGeo, accentMat, { y: 0.10, sx: P.torsoWidth * 1.04, sy: 0.24, sz: P.torsoDepth * 1.06 });

  const neck = bone('Neck', spine1, P.spine1ToNeck);
  part(neck, boxGeo, bodyMat, { y: P.neckLength, sx: 0.11, sy: P.neckLength * 2, sz: 0.11 });

  const head = bone('Head', neck, P.neckLength);
  const headMesh = part(head, sphereGeo, bodyMat, { y: P.headSize / 2 });
  headMesh.name = 'head';
  // Visor, so the facing direction is readable.
  part(head, boxGeo, visorMat, { y: P.headSize / 2 + 0.015, z: -P.headSize * 0.42, sx: 0.17, sy: 0.06, sz: 0.04 });

  for (const side of ['Left', 'Right'] as const) {
    const s = side === 'Left' ? -1 : 1;

    // ---- arm ----
    const shoulder = bone(`${side}Shoulder`, spine1, 0.17);
    shoulder.position.set(s * P.shoulderWidth, 0.17, 0);
    part(shoulder, boxGeo, accentMat, { x: s * 0.05, sx: 0.13, sy: 0.15, sz: 0.19 });

    const arm = bone(`${side}Arm`, shoulder, 0);
    arm.position.set(s * 0.09, 0, 0);
    part(arm, armGeo, bodyMat, { y: -P.upperArm / 2, sy: P.upperArm, axis: 'y' });

    const foreArm = bone(`${side}ForeArm`, arm, -P.upperArm);
    part(foreArm, armGeo, bodyMat, { y: -P.foreArm / 2, sy: P.foreArm, axis: 'y' });

    const hand = bone(`${side}Hand`, foreArm, -P.foreArm);
    part(hand, boxGeo, darkAccentMat, { y: -0.05, sx: 0.09, sy: 0.12, sz: 0.08 });

    // ---- leg ----
    // The hip joint sits a little below and outboard of the pelvis centre.
    const upLeg = bone(`${side}UpLeg`, hips, -0.05);
    upLeg.position.set(s * P.hipSpacing, -0.05, 0);    part(upLeg, legGeo, darkAccentMat, { y: -P.thigh / 2, sy: P.thigh, axis: 'y' });

    const leg = bone(`${side}Leg`, upLeg, -P.thigh);
    part(leg, legGeo, darkAccentMat, { y: -P.shin / 2, sy: P.shin, axis: 'y' });

    const foot = bone(`${side}Foot`, leg, -P.shin);
    // The foot bone sits at y = 0.06; centring the block at -0.02 puts its
    // underside exactly on y = 0.
    part(foot, boxGeo, bodyMat, { y: -0.02, z: -0.05, sx: 0.10, sy: P.footHeight, sz: 0.25 });
  }

  // Rest pose: arms down and slightly out, legs straight.
  bones.LeftArm.rotation.z = 0.14;
  bones.RightArm.rotation.z = -0.14;
  bones.LeftForeArm.rotation.x = -0.18;
  bones.RightForeArm.rotation.x = -0.18;

  return {
    root,
    bones,
    meshes,
    height: P.height,
    radius: 0.34,
    headBone: head,
    dispose() {
      for (const d of disposables) d.dispose();
      root.removeFromParent();
    },
  };
}

/**
 * Placeholder for the real character path. Once a Mixamo-rigged GLB is
 * supplied, this clones it with SkeletonUtils and retargets clips; the rest of
 * the codebase consumes the same `CharacterRig` interface.
 */
export function createCharacterFromGLTF(
  gltf: { scene: THREE.Object3D; animations: THREE.AnimationClip[] },
  team: TeamId
): CharacterRig {
  void gltf;
  void team;
  throw new Error(
    'createCharacterFromGLTF: no rigged character model supplied yet. ' +
      'See docs/MODEL-REPORT.md for what to download.'
  );
}
