/**
 * Automatic orientation of the first-person viewmodel.
 *
 * ## Why this exists
 *
 * The previous version rotated the loaded model by a hard-coded -90 degrees
 * about X, on the reasoning that "the barrel lies along +Y". That reasoning was
 * wrong, and it produced exactly the bug it was meant to prevent: a rifle
 * pointing straight up with the arms rising from the bottom of the screen.
 *
 * Two mistakes compounded:
 *
 * 1. The asset ALREADY carries a Z-up to Y-up conversion. `Sketchfab_model`
 *    rotates -90 about X and the `.fbx` node beneath it rotates +90 back, so
 *    those two cancel; then `Armature` (and the mesh nodes beside it) carry
 *    (-90, 0, 180), which is the real conversion. Applying our own -90 on top
 *    was a SECOND conversion, tipping the rig onto its back.
 *
 * 2. The barrel axis was read off `Box3.setFromObject()`. For a `SkinnedMesh`
 *    that returns the BIND POSE geometry bounds pushed through the mesh's
 *    `matrixWorld` — it does not apply the bind matrix and it does not apply the
 *    pose. It therefore describes a configuration the player never sees, and its
 *    longest axis is not the barrel.
 *
 * So the barrel is measured from the POSED geometry instead: the IDLE clip is
 * played, the skeleton is updated, and the gun's vertices are read through
 * `SkinnedMesh.getVertexPosition()`, which applies the skinning equation.
 *
 * ## Why the magazine is measured separately
 *
 * The three gun meshes are NOT interchangeable. Measured on this asset at the
 * IDLE pose:
 *
 *   Object_61  Krinkov     0.054 x 0.180 x 0.658   the rifle — barrel along Z
 *   Object_62  Null.001    0.031 x 0.044 x 0.419   bolt carrier, also along Z
 *   Object_63  Magazine    0.090 x 1.668 x 0.910   spans 1.67 m — NOT a magazine
 *
 * `Object_63` carries the `Magazine` material but its posed geometry is spread
 * over 1.67 m, far more than the rifle itself. Pooling it with the others
 * dominated the principal-axis solve and dragged the "barrel" onto Y — which is
 * exactly how the muzzle ended up on the magazine mesh. So the barrel, the
 * muzzle and the sight height are all measured from the gun BODY
 * (`Krinkov` / `Null.001`) alone, and the magazine is used only to decide which
 * way is up, where even a polluted centroid is still reliably below the bore.
 *
 * ## The result on this asset
 *
 * The rifle body's longest axis is Z with the muzzle at the -Z end, and the
 * magazine hangs below it, so the measured alignment is very nearly the
 * IDENTITY: the asset is already authored barrel-forward and sights-up, with the
 * camera at the `Neck` bone. That is what a first-person viewmodel should look
 * like, and it is why the hard-coded -90 was so destructive.
 *
 * ## Spaces
 *
 * Every point and direction here is reported in the ROOT's local space — the
 * space `model.position` and `model.scale` live in. That matters because the
 * caller overwrites both when it anchors and normalises, so a value measured in
 * world space would be off by whatever transform the loaded scene root happened
 * to carry.
 */
import * as THREE from 'three';

/** A measured axis, in the model's own space. */
export interface MeasuredAxis {
  /** Unit direction. */
  direction: THREE.Vector3;
  /** A point the axis passes through, for reporting. */
  origin: THREE.Vector3;
  /** Length of the gun along this axis, in model units. */
  extent: number;
}

export interface ViewmodelAlignment {
  /** Rotation that brings the barrel onto -Z and the sights onto +Y. */
  quaternion: THREE.Quaternion;
  /** The barrel axis as measured, before alignment. */
  barrel: MeasuredAxis;
  /** The up axis (magazine -> receiver) as measured, before alignment. */
  up: MeasuredAxis;
  /** Where the Neck bone sits, in model space, at the IDLE pose. */
  neck: THREE.Vector3;
  /** Muzzle position in model space at the IDLE pose. */
  muzzle: THREE.Vector3;
  /**
   * The mesh and vertex index of the muzzle.
   *
   * The muzzle is tracked per frame by re-skinning that ONE vertex, which is
   * exact for a mesh skinned across several bones and costs nothing. Tracking it
   * through a single "dominant" bone would be an approximation that drifts as
   * the SHOOT and RELOAD clips flex the weapon.
   */
  gunMesh: THREE.SkinnedMesh | null;
  muzzleVertex: number;
  /** Gun length in model units, for scale normalisation. */
  gunExtent: number;
  /** Height of the front sight post above the bore line, in model units. */
  sightHeight: number;
  /**
   * The rear sight notch, in model space at the IDLE pose.
   *
   * The eye lines up THROUGH this, so together with `frontSight` it defines the
   * sight line — and the sight line is what the ADS hold has to put on the camera
   * axis. The bore line alone is not enough: the two sights sit at different
   * heights, so the line between them is not parallel to the barrel, and that
   * difference is exactly the angle the camera has to look along.
   */
  rearSight: THREE.Vector3;
  /** The top of the front sight post, in model space at the IDLE pose. */
  frontSight: THREE.Vector3;
  /** Unit direction from the rear notch to the front post, in model space. */
  sightAxis: THREE.Vector3;
  /** Human-readable trace, for the console report. */
  log: string[];
}

/** The rifle body: receiver, barrel, bolt carrier. NOT the magazine. */
const GUN_BODY_MATERIAL = /krinkov|null\.001/i;
/** The magazine, which hangs below the bore line and so defines "down". */
const MAGAZINE_MATERIAL = /magazine/i;

/**
 * Measures the barrel, up and sight height of a viewmodel, posed by `clip`.
 *
 * The caller must NOT have applied any rotation of its own: the axes are
 * reported in the model's own space, so that the returned quaternion is the only
 * rotation needed.
 */
export function measureViewmodel(
  root: THREE.Object3D,
  clip: THREE.AnimationClip | null
): ViewmodelAlignment {
  const log: string[] = [];

  // ---- 1. pose the rig with the IDLE clip ----
  // A throwaway mixer: AnimationMixer caches its property bindings per instance,
  // so this cannot disturb the real one created later.
  const mixer = new THREE.AnimationMixer(root);
  if (clip) {
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    // Sampling mid-clip lands where the hands are actually gripping the weapon;
    // t = 0 can catch the first frame of a blend-in.
    mixer.setTime(clip.duration * 0.5);
  }
  root.updateMatrixWorld(true);

  // See the "Spaces" note above.
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();

  // ---- 2. the Neck bone, which is where the camera is authored to sit ----
  let neckObject: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (neckObject) return;
    if (/neck/i.test(o.name)) neckObject = o;
  });
  const neck = new THREE.Vector3();
  if (neckObject) {
    neck.setFromMatrixPosition((neckObject as THREE.Object3D).matrixWorld).applyMatrix4(toLocal);
    log.push(`neck bone "${(neckObject as THREE.Object3D).name}" at ${fmt(neck)}`);
  } else {
    log.push('no Neck bone found — the anchor falls back to the model origin');
  }

  // ---- 3. collect posed vertices, body and magazine separately ----
  const bodyPoints: THREE.Vector3[] = [];
  const bodyMeshes: THREE.SkinnedMesh[] = [];
  const magazinePoints: THREE.Vector3[] = [];

  const tmp = new THREE.Vector3();

  /** Posed vertex `i` of `mesh`, in the root's local space. */
  const posed = (mesh: THREE.SkinnedMesh, i: number): THREE.Vector3 => {
    if (mesh.isSkinnedMesh) {
      // Applies the skinning equation, then lifts into world space — the same
      // idiom three.js itself uses in Box3.expandByObject.
      mesh.getVertexPosition(i, tmp);
      tmp.applyMatrix4(mesh.matrixWorld);
    } else {
      tmp.fromBufferAttribute(mesh.geometry.getAttribute('position') as THREE.BufferAttribute, i);
      tmp.applyMatrix4(mesh.matrixWorld);
    }
    return tmp.applyMatrix4(toLocal);
  };

  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!(mesh as unknown as THREE.Mesh).isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const names = mats.map((m) => m?.name ?? '');
    const isBody = names.some((n) => GUN_BODY_MATERIAL.test(n));
    const isMagazine = !isBody && names.some((n) => MAGAZINE_MATERIAL.test(n));
    if (!isBody && !isMagazine) return;

    if (isBody) {
      // Every vertex: the muzzle tip and the front sight post must not be missed.
      bodyMeshes.push(mesh);
      for (let i = 0; i < position.count; i++) bodyPoints.push(posed(mesh, i).clone());
    } else {
      // Only a centroid is needed, and the mesh may be large.
      const stride = Math.max(1, Math.floor(position.count / 2000));
      for (let i = 0; i < position.count; i += stride) {
        magazinePoints.push(posed(mesh, i).clone());
      }
    }
  });

  const result: ViewmodelAlignment = {
    quaternion: new THREE.Quaternion(),
    barrel: { direction: new THREE.Vector3(0, 0, -1), origin: new THREE.Vector3(), extent: 0 },
    up: { direction: new THREE.Vector3(0, 1, 0), origin: new THREE.Vector3(), extent: 0 },
    neck,
    muzzle: new THREE.Vector3(),
    gunMesh: null,
    muzzleVertex: -1,
    gunExtent: 0,
    sightHeight: 0,
    rearSight: new THREE.Vector3(),
    frontSight: new THREE.Vector3(),
    sightAxis: new THREE.Vector3(0, 0, -1),
    log,
  };

  if (bodyPoints.length < 8) {
    log.push(`only ${bodyPoints.length} gun-body vertices found — keeping the identity rotation`);
    mixer.stopAllAction();
    return result;
  }

  // ---- 4. the barrel: longest principal axis of the gun BODY ----
  const bodyCentroid = average(bodyPoints);
  const barrel = principalAxis(bodyPoints, bodyCentroid);

  // ---- 5. sign the barrel: the muzzle is the end further from the neck ----
  // The neck is the camera, so the muzzle is unambiguously the far end. Using the
  // neck rather than the arms' centroid also keeps this correct for a model whose
  // arms are asymmetric.
  const along = new THREE.Vector3();
  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const p of bodyPoints) {
    const d = along.subVectors(p, bodyCentroid).dot(barrel);
    if (d < minProj) minProj = d;
    if (d > maxProj) maxProj = d;
  }
  const endMin = bodyCentroid.clone().addScaledVector(barrel, minProj);
  const endMax = bodyCentroid.clone().addScaledVector(barrel, maxProj);
  const muzzleIsMax = endMax.distanceTo(neck) > endMin.distanceTo(neck);
  if (!muzzleIsMax) barrel.negate();

  const gunExtent = maxProj - minProj;
  result.barrel = { direction: barrel.clone(), origin: bodyCentroid.clone(), extent: gunExtent };
  result.gunExtent = gunExtent;
  log.push(
    `barrel axis ${fmt(barrel)} | length ${gunExtent.toFixed(4)} units | ` +
      `muzzle at the ${muzzleIsMax ? 'max' : 'min'} end of the principal axis`
  );

  // ---- 6. the up axis ----
  // The gun body's own second principal axis is its vertical one (for a rifle,
  // height > width), and the magazine only has to say which way is down. That is
  // robust even though the magazine mesh's centroid is unreliable.
  const up = secondAxis(bodyPoints, bodyCentroid, barrel);
  if (magazinePoints.length >= 8) {
    const magCentroid = average(magazinePoints);
    const down = along.subVectors(magCentroid, bodyCentroid);
    if (up.dot(down) > 0) up.negate();
    log.push(
      `up axis ${fmt(up)} (gun body's second principal axis, signed by the ` +
        `magazine centroid at ${fmt(magCentroid)})`
    );
  } else {
    if (up.dot(new THREE.Vector3(0, 1, 0)) < 0) up.negate();
    log.push(`up axis ${fmt(up)} (no magazine mesh — signed toward world up)`);
  }
  result.up = { direction: up.clone(), origin: bodyCentroid.clone(), extent: 0 };

  // ---- 7. the rotation: barrel -> -Z, up -> +Y ----
  // Built as a basis change, so it is exact rather than a sequence of guesses.
  //
  //   f = barrel   must land on -Z
  //   u = up       must land on +Y
  //   r = f x u    then lands on (-Z) x (+Y) = +X
  //
  // So the model-space basis (r, u, -f) maps onto the identity basis, and the
  // rotation is its transpose. (r, u, -f) is right-handed: r . (u x -f) = 1.
  const right = new THREE.Vector3().crossVectors(barrel, up).normalize();
  const trueUp = new THREE.Vector3().crossVectors(right, barrel).normalize();
  const source = new THREE.Matrix4().makeBasis(right, trueUp, barrel.clone().negate());
  result.quaternion.setFromRotationMatrix(source.transpose());
  log.push(
    `alignment quaternion ${fmt4(result.quaternion)} ` +
      `(barrel ${fmt(barrel)} -> -Z, up ${fmt(up)} -> +Y)`
  );

  // ---- 8. the muzzle vertex ----
  // Found by search, so a model whose barrel does not sit on the centre line still
  // reports its muzzle correctly. The mesh and index are kept so the muzzle can be
  // re-skinned every frame.
  let bestProjection = -Infinity;
  for (const mesh of bodyMeshes) {
    const position = mesh.geometry.getAttribute('position');
    if (!position) continue;
    for (let i = 0; i < position.count; i++) {
      const p = posed(mesh, i);
      const d = along.subVectors(p, bodyCentroid).dot(barrel);
      if (d > bestProjection) {
        bestProjection = d;
        result.muzzle.copy(p);
        result.gunMesh = mesh;
        result.muzzleVertex = i;
      }
    }
  }
  log.push(
    `muzzle at ${fmt(result.muzzle)} (${bestProjection.toFixed(4)} along the barrel) ` +
      `on vertex ${result.muzzleVertex} of "${result.gunMesh?.name ?? '?'}"`
  );

  // ---- 9. the sights: rear notch and front post ----
  // Measured in the ALIGNED frame, where the barrel runs along -Z and up is +Y,
  // so "further behind the muzzle" is +z and "higher" is +y.
  //
  // BOTH sights are needed, and this is the whole point of the step. The eye
  // looks THROUGH the rear notch at the front post, so the sight line is the
  // segment between them — and because the two sit at different heights above
  // the bore, that line is NOT parallel to the barrel. Aligning the BARREL to the
  // camera axis (which is what this used to do) therefore leaves the camera
  // looking a degree or so below the notch, straight into the back of the
  // receiver. That is exactly the "I see the receiver instead of the sights" bug.
  const q = result.quaternion;
  const aligned = new THREE.Vector3();

  /** Height above the bore line, in the aligned frame. */
  const heightAboveBore = (p: THREE.Vector3) =>
    aligned.copy(p).sub(neck).applyQuaternion(q).y;

  /** Distance behind the muzzle, in model units. */
  const backFromMuzzle = (p: THREE.Vector3) =>
    bestProjection - along.subVectors(p, bodyCentroid).dot(barrel);

  // The bore line is the barrel axis the principal-axis solve found, which passes
  // through the gun body's centroid. Using the centroid rather than the muzzle
  // matters: the muzzle vertex is a flash-hider tip and can sit off the axis.
  const boreY = heightAboveBore(bodyCentroid);

  // Flatten every body vertex to (distance behind the muzzle, height above bore).
  // Typed arrays rather than Vector3s: this is tens of thousands of vertices and
  // only two of them are ever wanted as points.
  let total = 0;
  for (const mesh of bodyMeshes) total += mesh.geometry.getAttribute('position')?.count ?? 0;
  const backs = new Float32Array(total);
  const heights = new Float32Array(total);
  const meshOf = new Int32Array(total);
  const vertexOf = new Int32Array(total);

  let w = 0;
  for (let mi = 0; mi < bodyMeshes.length; mi++) {
    const mesh = bodyMeshes[mi];
    const position = mesh.geometry.getAttribute('position');
    if (!position) continue;
    for (let i = 0; i < position.count; i++) {
      const p = posed(mesh, i);
      backs[w] = backFromMuzzle(p);
      heights[w] = heightAboveBore(p) - boreY;
      meshOf[w] = mi;
      vertexOf[w] = i;
      w++;
    }
  }

  // The height profile, logged so the two sight bands below can be checked
  // against real geometry rather than trusted. Each entry is
  // "fraction of the gun's length behind the muzzle : top height above the bore".
  const BINS = 24;
  const profileMax = new Float32Array(BINS).fill(-Infinity);
  for (let i = 0; i < w; i++) {
    const bin = Math.min(BINS - 1, Math.max(0, Math.floor((backs[i] / gunExtent) * BINS)));
    if (heights[i] > profileMax[bin]) profileMax[bin] = heights[i];
  }
  log.push(
    'height profile (fraction behind the muzzle : top y above the bore) ' +
      Array.from(profileMax, (v, i) =>
        `${(i / BINS).toFixed(2)}:${Number.isFinite(v) ? v.toFixed(3) : 'n/a'}`
      ).join(' ')
  );

  // ---- the two bands ----
  // The front post is the highest point of the front quarter of the weapon: on an
  // AK that is unambiguously the post on its block, because the barrel and gas tube
  // are below it.
  //
  // The rear notch is the top of the rear sight on the receiver cover. It is found
  // by taking the highest point in a band that starts behind the front sight and
  // stops before the stock — the stock of an AK-74U is a side-folder that sits at
  // or below bore height, so including it would not change the answer, but the
  // band is bounded anyway so the result does not depend on that being true.
  const FRONT_BAND = 0.25;
  const REAR_BAND_LO = 0.3;
  const REAR_BAND_HI = 0.75;

  let frontIndex = -1;
  let frontTop = -Infinity;
  let rearIndex = -1;
  let rearTop = -Infinity;
  for (let i = 0; i < w; i++) {
    const frac = backs[i] / gunExtent;
    if (frac <= FRONT_BAND && heights[i] > frontTop) {
      frontTop = heights[i];
      frontIndex = i;
    }
    if (frac >= REAR_BAND_LO && frac <= REAR_BAND_HI && heights[i] > rearTop) {
      rearTop = heights[i];
      rearIndex = i;
    }
  }

  const pointAt = (index: number) =>
    posed(bodyMeshes[meshOf[index]], vertexOf[index]).clone();

  if (frontIndex >= 0) result.frontSight.copy(pointAt(frontIndex));
  if (rearIndex >= 0) result.rearSight.copy(pointAt(rearIndex));
  result.sightHeight = Number.isFinite(frontTop) ? frontTop : 0;

  if (frontIndex < 0 || rearIndex < 0) {
    log.push('could not locate both sights — falling back to the bore line for ADS');
    result.sightAxis.copy(barrel);
  } else {
    result.sightAxis.subVectors(result.frontSight, result.rearSight).normalize();
    const offBore =
      (Math.acos(THREE.MathUtils.clamp(result.sightAxis.dot(barrel), -1, 1)) * 180) / Math.PI;
    log.push(
      `rear sight notch at ${fmt(result.rearSight)} ` +
        `(${(backs[rearIndex] / gunExtent).toFixed(3)} behind the muzzle, ` +
        `${rearTop.toFixed(4)} above the bore)`
    );
    log.push(
      `front sight post at ${fmt(result.frontSight)} ` +
        `(${(backs[frontIndex] / gunExtent).toFixed(3)} behind the muzzle, ` +
        `${frontTop.toFixed(4)} above the bore)`
    );
    log.push(
      `sight axis ${fmt(result.sightAxis)} — ${offBore.toFixed(2)}° off the bore, ` +
        `and that is the angle the camera has to look along to see through the notch`
    );
  }

  mixer.stopAllAction();
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(v: THREE.Vector3): string {
  return `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}]`;
}

function fmt4(q: THREE.Quaternion): string {
  return `[${q.x.toFixed(3)}, ${q.y.toFixed(3)}, ${q.z.toFixed(3)}, ${q.w.toFixed(3)}]`;
}

function average(points: THREE.Vector3[]): THREE.Vector3 {
  const out = new THREE.Vector3();
  if (!points.length) return out;
  for (const p of points) out.add(p);
  return out.divideScalar(points.length);
}

/** Row-major 3x3 covariance, as a flat array of 9. */
function covariance(points: THREE.Vector3[], centroid: THREE.Vector3): number[] {
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const x = p.x - centroid.x;
    const y = p.y - centroid.y;
    const z = p.z - centroid.z;
    c[0] += x * x;
    c[1] += x * y;
    c[2] += x * z;
    c[3] += y * x;
    c[4] += y * y;
    c[5] += y * z;
    c[6] += z * x;
    c[7] += z * y;
    c[8] += z * z;
  }
  const n = Math.max(points.length, 1);
  return c.map((v) => v / n);
}

function applyCovariance(c: number[], v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    c[0] * v.x + c[1] * v.y + c[2] * v.z,
    c[3] * v.x + c[4] * v.y + c[5] * v.z,
    c[6] * v.x + c[7] * v.y + c[8] * v.z
  );
}

/**
 * The principal (longest) axis of a point cloud, by power iteration on the
 * covariance matrix. For a rifle this converges to the barrel in a handful of
 * iterations and needs no SVD dependency.
 */
function principalAxis(points: THREE.Vector3[], centroid: THREE.Vector3): THREE.Vector3 {
  const cov = covariance(points, centroid);
  let v = new THREE.Vector3(0.3, 0.9, 0.3).normalize();
  for (let i = 0; i < 48; i++) {
    const next = applyCovariance(cov, v);
    if (next.lengthSq() < 1e-20) return new THREE.Vector3(0, 0, -1);
    v = next.normalize();
  }
  return v;
}

/**
 * The axis orthogonal to `exclude` with the largest variance.
 *
 * Deflates the dominant eigenpair out of the covariance (C - lambda * v v^T)
 * and power-iterates what is left, which is the textbook way to get the second
 * principal axis without a full eigen solver.
 */
function secondAxis(
  points: THREE.Vector3[],
  centroid: THREE.Vector3,
  exclude: THREE.Vector3
): THREE.Vector3 {
  const cov = covariance(points, centroid);
  const v1 = exclude.clone().normalize();
  const lambda = v1.dot(applyCovariance(cov, v1));
  const axis = [v1.x, v1.y, v1.z];
  const deflated = cov.map((value, index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    return value - lambda * axis[row] * axis[col];
  });

  let v = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 48; i++) {
    const next = applyCovariance(deflated, v);
    if (next.lengthSq() < 1e-20) return new THREE.Vector3(0, 1, 0);
    v = next.normalize();
  }
  return v;
}
