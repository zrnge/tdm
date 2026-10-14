/**
 * F3 debug overlay.
 *
 * Draws, all in one group that toggles together:
 *
 *   - the spawn-to-spawn sightline, RED when it is clear (a layout failure,
 *     because the brief requires it blocked) and GREEN when cover breaks it,
 *     with a marker where the ray is stopped;
 *   - a wireframe box around every cover prop, so the layout can be read at a
 *     glance and compared against the lanes described in `cover.ts`;
 *   - the two spawn zones as wireframe boxes;
 *   - **the navmesh**, as a wireframe over the walkable surface, so it is
 *     immediately obvious whether bots have a mesh to walk on and where its
 *     edges are;
 *   - **each bot's vision cone**, drawn as a translucent wedge at eye height,
 *     green while patrolling and red while engaging;
 *   - **a line from each bot to its target** when it has sight, and a dashed
 *     line to its last known position when it does not;
 *   - **each bot's current path**, as a polyline of waypoints;
 *   - **a state label above each bot's head**, as a canvas sprite.
 *
 * The labels are sprites rather than DOM elements because they must be occluded
 * correctly and must scale with distance; a DOM label would float over walls.
 */
import * as THREE from 'three';
import type { Physics } from '../core/physics';
import type { Level } from '../level/level';
import type { NavMeshSystem } from '../nav/navmesh';
import type { Bot } from '../bots/bot';
import { BOT } from '../config';
import { RAPIER } from '../core/physics';

export interface DebugOverlay {
  readonly visible: boolean;
  /** Call once per frame. Cheap when hidden. */
  update(): void;
  toggle(): void;
  dispose(): void;
}

export interface DebugOverlayOptions {
  scene: THREE.Scene;
  physics: Physics;
  level: Level;
  navmesh: NavMeshSystem;
  /** Read live, because bots are created after the overlay. */
  bots: () => Bot[];
}

/** Cone colour while patrolling. */
const CONE_PATROL = 0x66ccff;
/** Cone colour while engaging. */
const CONE_ENGAGE = 0xff4444;
/** Cone colour while reloading. */
const CONE_RELOAD = 0xffcc44;

export function createDebugOverlay(opts: DebugOverlayOptions): DebugOverlay {
  const { scene, physics, level, navmesh } = opts;

  const root = new THREE.Group();
  root.name = 'debug-overlay';
  root.visible = false;
  scene.add(root);

  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  // ---- spawn sightline ----
  const sightGeo = new THREE.BufferGeometry().setFromPoints([
    level.cover.sightline.from,
    level.cover.sightline.to,
  ]);
  const sightMat = new THREE.LineBasicMaterial({ color: 0x00ff66, transparent: true, opacity: 0.9 });
  const sightLine = new THREE.Line(sightGeo, sightMat);
  sightLine.name = 'debug-sightline';
  root.add(sightLine);
  disposables.push(sightGeo, sightMat);

  const stopGeo = new THREE.SphereGeometry(0.18, 12, 8);
  const stopMat = new THREE.MeshBasicMaterial({ color: 0x00ff66 });
  const stopMarker = new THREE.Mesh(stopGeo, stopMat);
  stopMarker.name = 'debug-sightline-stop';
  root.add(stopMarker);
  disposables.push(stopGeo, stopMat);

  // ---- cover wireframes ----
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const boxMat = new THREE.LineBasicMaterial({ color: 0x6fd3ff, transparent: true, opacity: 0.35 });
  disposables.push(boxGeo, boxMat);

  const coverColliders = level.cover.colliders;
  const boxes = new THREE.InstancedMesh(boxGeo, boxMat, coverColliders.length);
  boxes.name = 'debug-cover-boxes';
  boxes.frustumCulled = false;

  const dummy = new THREE.Object3D();
  const q = new THREE.Quaternion();
  coverColliders.forEach((collider, i) => {
    const half = collider.halfExtents();
    const t = collider.translation();
    const r = collider.rotation();
    if (!half) return;
    q.set(r.x, r.y, r.z, r.w);
    dummy.position.set(t.x, t.y, t.z);
    dummy.quaternion.copy(q);
    dummy.scale.set(half.x * 2, half.y * 2, half.z * 2);
    dummy.updateMatrix();
    boxes.setMatrixAt(i, dummy.matrix);
  });
  boxes.instanceMatrix.needsUpdate = true;
  root.add(boxes);

  // ---- spawn zones ----
  const zoneMat = new THREE.LineBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.5 });
  disposables.push(zoneMat);
  for (const zone of level.spawnZones) {
    const g = new THREE.BoxGeometry(zone.half.x * 2, 2.2, zone.half.z * 2);
    const m = new THREE.LineSegments(new THREE.EdgesGeometry(g), zoneMat);
    m.position.set(zone.center.x, 1.1, zone.center.z);
    m.name = `debug-zone-${zone.team}`;
    root.add(m);
    disposables.push(g);
  }

  // ---- navmesh wireframe ----
  if (navmesh.debugLines) {
    const navMat = new THREE.LineBasicMaterial({
      color: 0x39ff88,
      transparent: true,
      opacity: 0.22,
    });
    const navLines = new THREE.LineSegments(navmesh.debugLines, navMat);
    navLines.name = 'debug-navmesh';
    // Lifted a few centimetres so it does not z-fight with the floor.
    navLines.position.y = 0.03;
    root.add(navLines);
    disposables.push(navMat);
  }

  // ---- per-bot visuals ----
  // Built lazily on the first update that has bots, because bots are created
  // after this overlay in `main.ts`.
  let botRoot: THREE.Group | null = null;
  let coneMeshes: THREE.Mesh[] = [];
  let sightLines: THREE.Line[] = [];
  let pathLines: THREE.Line[] = [];
  let labels: THREE.Sprite[] = [];
  let labelTextures: THREE.CanvasTexture[] = [];

  const coneGeo = buildConeGeometry();
  disposables.push(coneGeo);

  /** One canvas per bot, redrawn when its state text changes. */
  function makeLabel(): { sprite: THREE.Sprite; texture: THREE.CanvasTexture; canvas: HTMLCanvasElement } {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.6, 0.4, 1);
    disposables.push(texture, mat);
    labelTextures.push(texture);
    return { sprite, texture, canvas };
  }

  function drawLabel(canvas: HTMLCanvasElement, texture: THREE.CanvasTexture, text: string, color: string) {
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 34px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Outline first, so the text stays readable over any background.
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
  }

  function ensureBotVisuals(bots: Bot[]) {
    if (botRoot && coneMeshes.length === bots.length) return;
    // Rebuild when the bot count changes. Bots are created once at match start,
    // so this runs once in practice.
    if (botRoot) {
      botRoot.removeFromParent();
      for (const m of coneMeshes) (m.material as THREE.Material).dispose();
      for (const l of sightLines) (l.material as THREE.Material).dispose();
      for (const l of pathLines) (l.material as THREE.Material).dispose();
      for (const s of labels) (s.material as THREE.Material).dispose();
      coneMeshes = [];
      sightLines = [];
      pathLines = [];
      labels = [];
    }

    botRoot = new THREE.Group();
    botRoot.name = 'debug-bots';
    root.add(botRoot);

    for (let i = 0; i < bots.length; i++) {
      const coneMat = new THREE.MeshBasicMaterial({
        color: CONE_PATROL,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.name = `debug-cone-${bots[i].id}`;
      cone.frustumCulled = false;
      botRoot.add(cone);
      coneMeshes.push(cone);

      const sightMat = new THREE.LineBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.9 });
      const sight = new THREE.Line(new THREE.BufferGeometry().setFromPoints([ZERO, ZERO]), sightMat);
      sight.frustumCulled = false;
      botRoot.add(sight);
      sightLines.push(sight);

      const pathMat = new THREE.LineBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.8 });
      const pl = new THREE.Line(new THREE.BufferGeometry().setFromPoints([ZERO, ZERO]), pathMat);
      pl.frustumCulled = false;
      botRoot.add(pl);
      pathLines.push(pl);

      const { sprite, texture, canvas } = makeLabel();
      sprite.name = `debug-label-${bots[i].id}`;
      botRoot.add(sprite);
      labels.push(sprite);
      labelCanvases.push({ canvas, texture, last: '' });
    }
  }

  const labelCanvases: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; last: string }[] = [];

  // ---- the ray used for the sightline test ----
  const from = level.cover.sightline.from;
  const to = level.cover.sightline.to;
  const dir = new THREE.Vector3().subVectors(to, from);
  const distance = dir.length();
  dir.normalize();

  let visible = false;
  let lastClear: boolean | null = null;

  function refresh() {
    const ray = new RAPIER.Ray(
      { x: from.x, y: from.y, z: from.z },
      { x: dir.x, y: dir.y, z: dir.z }
    );
    const hit = physics.world.castRay(
      ray,
      distance,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      physics.blocksRays
    );
    const clear = hit === null;

    sightMat.color.setHex(clear ? 0xff2222 : 0x00ff66);
    stopMat.color.setHex(clear ? 0xff2222 : 0x00ff66);

    if (hit) {
      const t = hit.timeOfImpact;
      stopMarker.position.set(from.x + dir.x * t, from.y + dir.y * t, from.z + dir.z * t);
    } else {
      stopMarker.position.copy(to);
    }
    stopMarker.visible = true;

    if (clear !== lastClear) {
      lastClear = clear;
      console.log(
        clear
          ? '[debug] spawn sightline is CLEAR — the cover layout does not satisfy the brief. ' +
              'The line is drawn red.'
          : '[debug] spawn sightline is blocked by cover (pass). The line is drawn green.'
      );
    }
  }

  /** Updates the per-bot cones, sight lines, paths and labels. */
  function refreshBots() {
    const bots = opts.bots();
    if (!bots.length) return;
    ensureBotVisuals(bots);

    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      const cone = coneMeshes[i];
      const sight = sightLines[i];
      const pathLine = pathLines[i];
      const label = labels[i];

      // ---- vision cone ----
      // Placed at the bot's eye, pointing along its facing. The cone geometry is
      // built once with its apex at the origin and its axis down -Z, so a yaw
      // rotation is all that is needed.
      const eyeY = bot.position.y + BOT.eyeHeight;
      cone.position.set(bot.position.x, eyeY, bot.position.z);
      cone.rotation.y = Math.atan2(-bot.forward.x, -bot.forward.z);
      const mat = cone.material as THREE.MeshBasicMaterial;
      mat.color.setHex(
        bot.state === 'Reload' ? CONE_RELOAD : bot.hasSight ? CONE_ENGAGE : CONE_PATROL
      );
      mat.opacity = bot.combatant.alive ? 0.12 : 0.04;

      // ---- sight line or last-known line ----
      const sightGeoAttr = sight.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (bot.hasSight && bot.target) {
        setLine(sightGeoAttr, bot.eye, bot.target.position);
        (sight.material as THREE.LineBasicMaterial).color.setHex(0xff2222);
        sight.visible = true;
      } else if (bot.lastKnown) {
        setLine(sightGeoAttr, bot.eye, bot.lastKnown);
        (sight.material as THREE.LineBasicMaterial).color.setHex(0xffaa00);
        sight.visible = true;
      } else {
        sight.visible = false;
      }
      sightGeoAttr.needsUpdate = true;

      // ---- path ----
      const path = bot.path;
      if (path.length > 1) {
        const points: THREE.Vector3[] = [bot.position.clone().setY(bot.position.y + 0.1)];
        for (const p of path) points.push(p.clone().setY(p.y + 0.1));
        pathLine.geometry.dispose();
        pathLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
        pathLine.visible = true;
      } else {
        pathLine.visible = false;
      }

      // ---- state label ----
      const text = `${bot.state}${bot.hasSight ? ' •' : ''} ${Math.round(bot.combatant.health)}hp`;
      const color =
        bot.state === 'Dead'
          ? '#888888'
          : bot.hasSight
            ? '#ff5555'
            : bot.state === 'Reload'
              ? '#ffcc44'
              : '#66ccff';
      const entry = labelCanvases[i];
      if (entry && entry.last !== text + color) {
        entry.last = text + color;
        drawLabel(entry.canvas, entry.texture, text, color);
      }
      label.position.set(bot.position.x, bot.position.y + 2.25, bot.position.z);
      label.visible = bot.combatant.alive;
    }
  }

  return {
    get visible() {
      return visible;
    },
    update() {
      if (!visible) return;
      refresh();
      refreshBots();
    },
    toggle() {
      visible = !visible;
      root.visible = visible;
      if (visible) {
        refresh();
        console.log(
          `[debug] overlay ON — ${coverColliders.length} cover colliders, ` +
            `${level.spawnZones.length} spawn zones, navmesh ` +
            `${navmesh.stats.polygons.toLocaleString('en-US')} polys, ` +
            `${opts.bots().length} bots. ` +
            `Green sightline = blocked (correct), red = clear (a bug). ` +
            `Cones: blue = patrol, red = engaging, yellow = reloading.`
        );
      } else {
        console.log('[debug] overlay OFF');
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      root.removeFromParent();
    },
  };
}

// ---------------------------------------------------------------------------

const ZERO = new THREE.Vector3(0, 0, 0);

/**
 * A vision cone: apex at the origin, opening along -Z, `range` long.
 *
 * Built once and shared by every bot. The cone is a fan of triangles rather than
 * a solid, so it reads as a volume without hiding the level behind it.
 */
function buildConeGeometry(): THREE.BufferGeometry {
  const range = BOT.perception.range;
  const halfAngle = THREE.MathUtils.degToRad(BOT.perception.fovDeg / 2);
  const segments = 20;
  const positions: number[] = [];

  const apex = new THREE.Vector3(0, 0, 0);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    // Only the forward half of the circle: the cone, not a sphere.
    const p0 = conePoint(a0, halfAngle, range);
    const p1 = conePoint(a1, halfAngle, range);
    positions.push(apex.x, apex.y, apex.z, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/** A point on the cone's surface at azimuth `azimuth` and half-angle `halfAngle`. */
function conePoint(azimuth: number, halfAngle: number, range: number): THREE.Vector3 {
  // The cone's axis is -Z. Sweeping azimuth around that axis traces the surface.
  const r = Math.sin(halfAngle) * range;
  const z = -Math.cos(halfAngle) * range;
  return new THREE.Vector3(Math.cos(azimuth) * r, Math.sin(azimuth) * r, z);
}

/** Rewrites a 2-point line's positions in place, avoiding a per-frame allocation. */
function setLine(attr: THREE.BufferAttribute, a: THREE.Vector3, b: THREE.Vector3) {
  attr.setXYZ(0, a.x, a.y, a.z);
  attr.setXYZ(1, b.x, b.y, b.z);
}
