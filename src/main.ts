/**
 * Game entry point.
 *
 * FIRST-PERSON. The player is drawn as the supplied arms + AK-74U viewmodel and
 * nothing else; bots keep full-body characters. Phase 2 scope: weapons, hitscan
 * shooting, damage, health and respawn. Bots arrive in Phase 3.
 *
 * ## The single scene
 *
 * There is ONE world scene, `engine.scene`, holding the level, the cover, the
 * bots and the effects. The viewmodel is the only thing outside it, and it is
 * composited over the top by `engine.setOverlay` with the depth buffer cleared
 * in between. Nothing else is rendered anywhere else.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BOT, CAMERA, COMBAT, MATCH, PLAYER, SPAWN, TEAM, VIEWMODEL } from './config';
import { createEngine } from './core/engine';
import { createPhysics, RAPIER } from './core/physics';
import { createInput } from './core/input';
import { loadLevel } from './level/level';
import { loadRifle } from './weapons/rifleAsset';
import { loadViewmodel } from './weapons/viewmodel';
import { createViewmodelDebug } from './weapons/viewmodelDebug';
import { createGripDebug } from './weapons/gripDebug';
import { createPlayer } from './player/player';
import { eyeWallClearance } from './player/player';
import { createPlayerHitbox } from './player/hitbox';
import { createFirstPersonCamera } from './player/camera';
import { createCombat, type Combatant } from './combat/combat';
import { createEffects } from './combat/effects';
import { createPlayerWeapons } from './weapons/playerWeapons';
import { createHud } from './hud/hud';
import { createCreditsScreen } from './hud/credits';
import { createPauseMenu } from './hud/pauseMenu';
import { createMatchEndScreen } from './hud/matchEnd';
import { createFpsCounter } from './hud/fps';
import { createSettings, VOLUME_GAIN } from './game/settings';
import { createMatch } from './game/match';
import { createDebugOverlay } from './debug/overlay';
import { createColliderView } from './debug/colliderView';
import { buildNavMesh } from './nav/navmesh';
import { createBotManager, type Difficulty } from './bots/bot';
import { loadSoldierSource } from './characters/character';
import { createAudio } from './audio/audio';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const bootEl = document.getElementById('boot')!;
const statusEl = document.getElementById('boot-status')!;
const startBtn = document.getElementById('boot-start') as HTMLButtonElement;

async function main() {
  const engine = createEngine(canvas);
  const input = createInput(canvas);
  const settings = createSettings();

  setStatus('Initialising physics…');
  const physics = await createPhysics();

  setStatus('Loading warehouse…');
  const level = await loadLevel(physics);
  engine.scene.add(level.root);

  // ---- lighting ----
  // Deliberately generous: the warehouse shell is a closed box, so almost all
  // light comes from these sources. Phase 4 replaces this with an HDRI + proper
  // skylight shafts through the roof.
  // Image-based lighting: PBR metals have nothing to reflect without an
  // environment map and render as flat, near-black surfaces. A prefiltered room
  // gives every metallic surface (soldier armour, rifles, warehouse steel) soft
  // reflections. The hemisphere and ambient fills are lowered to make room for it.
  const pmrem = new THREE.PMREMGenerator(engine.renderer);
  engine.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  engine.scene.environmentIntensity = 0.45;
  pmrem.dispose();

  const hemi = new THREE.HemisphereLight(0xa8c4e0, 0x3a3f47, 1.8);
  engine.scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xffffff, 0.3);
  engine.scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
  sun.position.set(10, 24, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  const r = Math.max(level.size.x, level.size.z) * 0.6;
  sun.shadow.camera.left = -r;
  sun.shadow.camera.right = r;
  sun.shadow.camera.top = r;
  sun.shadow.camera.bottom = -r;
  sun.shadow.bias = -0.0012;
  engine.scene.add(sun);
  engine.scene.add(sun.target);

  const lampSpacing = 7;
  const lampCount = Math.max(2, Math.ceil(level.size.z / lampSpacing));
  for (let i = 0; i < lampCount; i++) {
    const z = -level.size.z / 2 + (level.size.z * (i + 0.5)) / lampCount;
    const lamp = new THREE.PointLight(0xffd9a8, 30, 30, 2);
    lamp.position.set(0, level.size.y - 1.1, z);
    engine.scene.add(lamp);
  }
  for (const zone of level.spawnZones) {
    const lamp = new THREE.PointLight(TEAM[zone.team].accent, 14, 22, 2);
    lamp.position.set(zone.center.x, 3.2, zone.center.z);
    engine.scene.add(lamp);
  }

  // ---- assets ----
  setStatus('Loading viewmodel…');
  const viewmodel = await loadViewmodel();

  setStatus('Loading rifle…');
  const rifle = await loadRifle();

  setStatus('Loading soldier…');
  const soldier = await loadSoldierSource();

  setStatus('Building navmesh…');
  const navmesh = await buildNavMesh(level);

  // ---- the player ----
  // No visible body: the player is the viewmodel. The capsule is collision and
  // hit detection only.
  const spawn = level.randomSpawn('blue');
  const player = createPlayer(physics, input, spawn);
  player.yaw = Math.PI; // face the middle of the hall

  const hitbox = createPlayerHitbox();
  hitbox.update(player);
  engine.scene.add(hitbox.root);

  const camera = createFirstPersonCamera(player, engine.camera, settings);

  // The viewmodel is composited over the world with the depth buffer cleared in
  // between, so it can never clip into a wall.
  if (viewmodel) engine.setOverlay(viewmodel.scene, viewmodel.camera);

  // ---- combat ----
  const effects = createEffects(engine.scene);
  const hud = createHud(settings);
  const credits = createCreditsScreen();
  createFpsCounter();

  // ---- sound ----
  // Starts silent: browsers only allow audio after a click, so the context is
  // resumed by the "click to play" button below.
  const audio = createAudio();
  audio.setVolume(VOLUME_GAIN[settings.values.volume]);
  settings.onChange(() => audio.setVolume(VOLUME_GAIN[settings.values.volume]));
  settings.onTestSound(() => audio.test());

  const match = createMatch({
    onEnd(winner) {
      console.log(`[match] ${winner ? `${TEAM[winner].name} wins` : 'draw'}`);
      // The game freezes behind the result (see the paused check in the frame
      // loop) and the mouse is freed for the buttons.
      hud.setScoreboard(false, []);
      matchEnd.show({
        winner,
        scores: { ...match.scores },
        rows: match.scoreboard(combat.combatants, 'player'),
        playerTeam: 'blue',
      });
      if (document.pointerLockElement) document.exitPointerLock();
    },
  });

  const combat = createCombat(physics, {
    onDamage(target, amount, headshot, attacker) {
      if (target.id === 'player') {
        hud.damageFrom(angleToAttacker(attacker));
        audio.hurt(amount);
      } else {
        if (attacker?.id === 'player') {
          hud.hitMarker(headshot, false);
          if (target.health > 0) audio.hitmarker(headshot, false);
        }
        // A bot that is shot knows roughly where from, and reacts.
        bots.notifyDamaged(target.id, attacker);
      }
    },
    onDeath(target) {
      // The player has no body to hide; the viewmodel is hidden by the frame
      // loop while dead, which reads as the weapon being lowered.
      if (target.id !== 'player') audio.bodyfall(target.position);
    },
    onKill(attacker, target, headshot) {
      if (attacker.id === 'player') {
        hud.hitMarker(headshot, true);
        audio.hitmarker(headshot, true);
      }
      hud.addKill(attacker.id, attacker.team, target.id, target.team, headshot);
      match.record(attacker, target);
    },
    onRespawn(target) {
      placeAtSpawn(target);
    },
  });

  /**
   * Puts a combatant back at its own team's spawn, ready to fight. Used on
   * respawn and when a new match starts. For a bot, `combat.ts` has already
   * restored health and spawn protection, and `bot.ts` resets its own state
   * machine when it notices it is alive again.
   */
  function placeAtSpawn(target: Combatant) {
    if (target.id === 'player') {
      player.teleport(level.randomSpawn('blue'));
      player.yaw = Math.PI;
      player.pitch = 0;
      weapons.respawn();
      return;
    }
    bots.bots.find((b) => b.id === target.id)?.teleport(level.randomSpawn(target.team));
  }

  /** A fresh match in place: scores, clock, everyone alive at their spawn. */
  function resetMatch() {
    match.reset();
    for (const c of combat.combatants) {
      c.kills = 0;
      c.deaths = 0;
      c.assists = 0;
      c.alive = true;
      c.health = COMBAT.maxHealth;
      c.respawnIn = 0;
      c.protection = SPAWN.protectionTime;
      placeAtSpawn(c);
    }
    bots.resetMatch();
    hud.setScoreboard(false, []);
  }

  // ---- the player as a combatant ----
  // `root` is the invisible hit proxy, not a body: bots raycast against it to
  // hit and headshot the player.
  const self: Combatant = {
    id: 'player',
    team: 'blue',
    root: hitbox.root,
    headMeshes: hitbox.headMeshes,
    bodyMeshes: hitbox.bodyMeshes,
    position: player.position,
    eye: player.eye,
    bodyHandle: player.bodyHandle,
    health: COMBAT.maxHealth,
    alive: true,
    protection: SPAWN.protectionTime,
    respawnIn: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
  };
  combat.add(self);

  const weapons = createPlayerWeapons({
    input,
    player,
    combat,
    effects,
    camera: engine.camera,
    self,
    viewmodel,
    onShot(_weapon, hit) {
      audio.gunshot(null);
      if (!hit.target) audio.impact(hit.point, hit.surface);
      // The enemy hears the player's rifle — the whole hall can.
      bots.broadcastGunshot(player.eye, 'player');
    },
    onReload(_weapon, duration, empty) {
      // Sounds on the measured beats of the clip actually playing.
      const ev = VIEWMODEL.reload.events[empty ? 'RELOAD2' : 'RELOAD1'];
      const f = (s: number) => s / ev.duration;
      audio.reload(null, duration, empty, {
        release: f(ev.release),
        magOut: f(ev.magOut),
        magIn: f(ev.magIn),
        boltBack: 'boltBack' in ev ? f(ev.boltBack) : undefined,
        boltForward: 'boltForward' in ev ? f(ev.boltForward) : undefined,
      });
      // A reload is loud. Nearby enemies hear it, and rush.
      bots.broadcastReload(player.eye, 'blue', duration);
    },
  });

  // ---- tuning tools ----
  // F4 tunes the first-person viewmodel — the thing the player actually sees.
  const viewmodelDebug = createViewmodelDebug(input, () => viewmodel);
  // F5 tunes the bots' third-person rifle grip.
  const gripDebug = createGripDebug(input, () => bots.bots.map((b) => b.rig.rifle).filter(Boolean) as THREE.Object3D[]);

  // ---- bots ----
  // 1 vs 4: the player alone on BLUE against MATCH.enemyCount RED bots.
  let difficulty: Difficulty = 'normal';
  const _closest = new THREE.Vector3();
  const _playerAim = new THREE.Vector3();
  const bots = createBotManager({
    physics,
    combat,
    navmesh,
    effects,
    soldier,
    rifle,
    difficulty,
    coverProps: level.cover.props,
    // Bots can tell when the player is aiming at them — they can see the barrel.
    aimOf: (c) => (c === self ? engine.camera.getWorldDirection(_playerAim) : null),
    onShot(shooterId, origin, dir, hit) {
      // A bot's gunshot is heard by the other bots, which is what makes a
      // firefight pull the rest of the team toward it.
      bots.broadcastGunshot(origin, shooterId);
      audio.gunshot(origin);
      if (!hit.target) audio.impact(hit.point, hit.surface);

      // A round that misses the player but passes close by their head snaps
      // past: closest point on the shot's path to the player's eye.
      if (self.alive && hit.target !== self) {
        const along = THREE.MathUtils.clamp(
          _closest.subVectors(player.eye, origin).dot(dir),
          0,
          origin.distanceTo(hit.point)
        );
        _closest.copy(origin).addScaledVector(dir, along);
        if (along > 2 && _closest.distanceTo(player.eye) < 1.3) audio.whiz(_closest);
      }
    },
    onFootstep(_id, at, intensity) {
      audio.footstep(at, intensity);
    },
    onReload(_id, at, duration, empty) {
      audio.reload(at, duration, empty);
    },
  });

  for (let i = 1; i <= MATCH.enemyCount; i++) {
    const bot = bots.spawn(`bot-red-${i}`, 'red', level.randomSpawn('red'));
    engine.scene.add(bot.rig.root);
  }

  // Player footsteps: one per dip of the camera bob, so sound and view agree.
  let lastStep = 0;

  // ---- debug overlay (F3) ----
  const debugOverlay = createDebugOverlay({
    scene: engine.scene,
    physics,
    level,
    navmesh,
    bots: () => bots.bots,
  });
  // ---- physics debug view (F6) ----
  const colliderView = createColliderView(engine.scene, physics, level);

  // ---- camera clearance: prove the near plane is inside the capsule ----
  // The "camera goes inside a container" bug was the world near plane (0.3 m)
  // sitting two millimetres outside the camera's real clearance from a wall
  // (0.302 m), so pressing into a container sliced its wall away. Both numbers are
  // logged here on every start, so the two can never drift apart in silence again.
  {
    const clearance = eyeWallClearance();
    const margin = clearance - CAMERA.near;
    const eyeAboveCylinder = PLAYER.eyeHeight - (PLAYER.height / 2 + (PLAYER.height / 2 - PLAYER.radius));
    console.log(
      `[camera] capsule radius ${PLAYER.radius.toFixed(3)} m | ` +
        `camera offset from capsule centre: 0.000 m horizontal (vertical only) | ` +
        `near plane ${CAMERA.near.toFixed(3)} m`
    );
    console.log(
      `[camera] eye sits ${eyeAboveCylinder.toFixed(3)} m up inside the capsule's top ` +
        `hemisphere, where the horizontal radius is ` +
        `${(clearance - 0.02).toFixed(3)} m; with the controller's 0.02 m skin the camera ` +
        `can reach ${clearance.toFixed(3)} m from a wall — ` +
        `${margin > 0 ? `${(margin * 100).toFixed(1)} cm` : `${(-margin * 100).toFixed(1)} cm INSIDE`} ` +
        `clear of the near plane`
    );
    if (margin <= 0) {
      console.error(
        `[camera] CAMERA.near (${CAMERA.near}) is not inside the capsule clearance ` +
          `(${clearance.toFixed(3)}) — the camera will clip into walls.`
      );
    }
  }

  console.log(
    `[game] ready — first-person | spawn ${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)} | ` +
      `team ${TEAM.blue.name} | level ${level.size.x.toFixed(1)}x${level.size.z.toFixed(1)}m | ` +
      `viewmodel ${viewmodel ? 'loaded' : 'MISSING'}`
  );

  // ---- per-frame ----
  // True once the player has clicked into the game for the first time. Before
  // that the boot screen is up; after it, losing the pointer lock (Esc) means
  // the pause menu. Either way the match is frozen — see below.
  let started = false;

  engine.onUpdate((dt) => {
    viewmodelDebug.update(dt);
    gripDebug.update(dt);

    // ---- settings panel ----
    // Opening it drops the pointer lock, which is what frees the mouse for the
    // buttons. Movement is locked while it is open so the player does not walk
    // into a wall behind the panel.
    if (input.pressed('settings')) {
      if (settings.visible) settings.hide();
      else settings.show();
    }

    input.setMovementLocked(
      viewmodelDebug.active || gripDebug.active || credits.visible || settings.visible
    );

    // ---- paused: the boot screen, or the Esc menu ----
    // Nothing advances — not the clock, the bots, combat or physics — so the
    // match cannot run on behind a menu and nobody can be shot while it is up.
    // The engine still renders, so the frozen scene shows behind the overlay.
    if (!started || !input.pointerLocked || match.over) {
      input.endFrame();
      return;
    }

    if (input.pressed('debug')) debugOverlay.toggle();
    if (input.pressed('debugColliders')) colliderView.toggle();

    // Look speed: the sensitivity setting, eased toward the ADS setting as the
    // sights come up so the transition never jerks the view.
    player.lookScale =
      settings.values.sensitivity *
      THREE.MathUtils.lerp(1, settings.values.adsSensitivity, weapons.adsAmount);
    player.update(dt);
    hitbox.update(player);
    camera.setAiming(weapons.aiming && self.alive);
    camera.update(dt);

    // ---- combat ----
    if (self.alive) {
      weapons.update(dt);
      camera.setRecoil(weapons.recoilPitch, weapons.recoilYaw);
    } else {
      camera.setRecoil(0, 0);
    }
    combat.update(dt);
    match.update(dt);

    // ---- sound ----
    audio.updateListener(engine.camera);
    const step = Math.floor(camera.bobPhase / Math.PI);
    if (step !== lastStep) {
      lastStep = step;
      if (self.alive && player.grounded && camera.bobAmount > 0.25) {
        const intensity = THREE.MathUtils.clamp(player.speed / PLAYER.sprintSpeed, 0.2, 1) * (player.crouching ? 0.4 : 1);
        audio.footstep(null, intensity);
        // Enemies hear running from much further than walking; crouching is silent.
        if (!player.crouching) {
          const radius = player.sprinting ? BOT.tactics.footstepHearSprint : BOT.tactics.footstepHearWalk;
          bots.broadcastNoise(player.position, 'blue', radius);
        }
      }
    }
    audio.setHeartbeat(self.alive && self.health < 35 ? 1 - self.health / 35 : 0, dt);
    effects.update(dt);
    bots.update(dt);
    debugOverlay.update();

    // ---- the viewmodel: the player's only visible form ----
    if (viewmodel) {
      // Hidden while dead, so a corpse does not hold a rifle at eye level.
      viewmodel.root.visible = self.alive;
      viewmodel.update(dt, player, weapons.aiming && self.alive);
    }

    // ---- HUD ----
    const w = weapons.current;
    hud.update(
      {
        health: self.health,
        maxHealth: COMBAT.maxHealth,
        ammo: w.ammo,
        magazine: w.def.magazine,
        weaponName: w.def.name,
        reloading: w.reloading,
        reloadProgress: w.reloadProgress,
        spread: w.spread,
        ads: weapons.adsAmount,
        protection: self.protection,
        respawnIn: self.alive ? 0 : self.respawnIn,
        teams: {
          blue: { kills: match.scores.blue, name: TEAM.blue.name, accent: '#3b82f6' },
          red: { kills: match.scores.red, name: TEAM.red.name, accent: '#ef4444' },
        },
        timeRemaining: match.timeRemaining,
      },
      dt
    );

    if (input.active('scoreboard')) {
      hud.setScoreboard(true, match.scoreboard(combat.combatants, 'player'));
    } else if (!match.over) {
      hud.setScoreboard(false, []);
    }

    physics.step(dt);
    input.endFrame();
  });

  // ---- debug handle for automated verification ----
  Object.assign(window as unknown as Record<string, unknown>, {
    __GAME__: {
      engine,
      physics,
      level,
      player,
      camera,
      input,
      rifle,
      viewmodel,
      viewmodelDebug,
      gripDebug,
      combat,
      weapons,
      match,
      hud,
      self,
      hitbox,
      debugOverlay,
      colliderView,
      navmesh,
      bots,
      audio,
      THREE,
      /**
       * Distance from the camera to the nearest surface, in metres, and what it
       * hit.
       *
       * This is the measurement the near-plane fix is verified with: the camera
       * must never be closer to a surface than `CAMERA.near`, or the near plane
       * slices through the wall and the player sees inside it. Casts in all six
       * axis directions from the camera, because the failure shows up whichever
       * way the player is facing.
       *
       * The player's own body is excluded — it is a capsule the camera sits
       * inside, so it would otherwise report a distance of zero every time.
       */
      cameraClearance() {
        const origin = engine.camera.position;
        const dirs: [string, THREE.Vector3][] = [
          ['forward', new THREE.Vector3(0, 0, -1).applyQuaternion(engine.camera.quaternion)],
          ['back', new THREE.Vector3(0, 0, 1).applyQuaternion(engine.camera.quaternion)],
          ['left', new THREE.Vector3(-1, 0, 0).applyQuaternion(engine.camera.quaternion)],
          ['right', new THREE.Vector3(1, 0, 0).applyQuaternion(engine.camera.quaternion)],
          ['up', new THREE.Vector3(0, 1, 0)],
          ['down', new THREE.Vector3(0, -1, 0)],
        ];
        const out: Record<string, number | string | boolean> = {};
        let nearest = Infinity;
        let nearestDir = '';
        for (const [name, dir] of dirs) {
          const ray = new RAPIER.Ray(
            { x: origin.x, y: origin.y, z: origin.z },
            { x: dir.x, y: dir.y, z: dir.z }
          );
          const hit = physics.world.castRay(
            ray,
            10,
            true,
            undefined,
            undefined,
            undefined,
            physics.world.getRigidBody(player.bodyHandle)
          );
          const d = hit ? hit.timeOfImpact : Infinity;
          out[name] = Number.isFinite(d) ? +d.toFixed(3) : -1;
          if (d < nearest) {
            nearest = d;
            nearestDir = name;
          }
        }
        out.nearest = Number.isFinite(nearest) ? +nearest.toFixed(3) : -1;
        out.nearestDir = nearestDir;
        out.nearPlane = CAMERA.near;
        out.safe = nearest >= CAMERA.near;
        return out;
      },
      /** Fires a shot at a world point, for scripted testing. */
      testFire(target: THREE.Vector3) {
        const origin = player.eye.clone();
        const dir = new THREE.Vector3().subVectors(target, origin).normalize();
        return combat.fire(self, origin, origin.clone().addScaledVector(dir, 100), 24, 120);
      },
      /** Where the muzzle currently is, in world space. */
      muzzleWorld() {
        if (!viewmodel) return player.eye.toArray();
        return viewmodel.muzzle
          .clone()
          .applyMatrix4(engine.camera.matrixWorld)
          .toArray()
          .map((v) => +v.toFixed(3));
      },
      stats: () => ({
        position: player.position.toArray().map((v) => +v.toFixed(2)),
        velocity: player.velocity.toArray().map((v) => +v.toFixed(2)),
        grounded: player.grounded,
        crouching: player.crouching,
        sprinting: player.sprinting,
        speed: +player.speed.toFixed(2),
        cameraPos: engine.camera.position.toArray().map((v) => +v.toFixed(2)),
        cameraFov: +engine.camera.fov.toFixed(1),
        eyeHeight: +camera.eyeHeight.toFixed(3),
        levelSize: level.size.toArray().map((v) => +v.toFixed(2)),
        colliders: physics.world.colliders.len(),
        bodies: physics.world.bodies.len(),
        health: self.health,
        alive: self.alive,
        ammo: weapons.current.ammo,
        weapon: weapons.current.def.name,
        weaponSlots: weapons.slots.length,
        spread: +weapons.current.spread.toFixed(2),
        adsAmount: +weapons.adsAmount.toFixed(2),
        kills: self.kills,
        deaths: self.deaths,
        blueScore: match.scores.blue,
        redScore: match.scores.red,
        timeRemaining: +match.timeRemaining.toFixed(1),
        spawnSightlineClear: level.spawnSightlineClear(),
        coverProblems: level.cover.problems.length,
        // ---- navmesh ----
        navmeshPolygons: navmesh.stats.polygons,
        navmeshVertices: navmesh.stats.vertices,
        navmeshGenerationMs: +navmesh.stats.generationMs.toFixed(0),
        navmeshInputTriangles: navmesh.stats.inputTriangles,
        navmeshError: navmesh.stats.error,
        navmeshReady: !!navmesh.query,
        // ---- bots ----
        botCount: bots.bots.length,
        bots: bots.bots.map((b) => ({
          id: b.id,
          team: b.team,
          state: b.state,
          health: Math.round(b.combatant.health),
          alive: b.combatant.alive,
          protection: +b.combatant.protection.toFixed(2),
          kills: b.combatant.kills,
          deaths: b.combatant.deaths,
          position: b.position.toArray().map((v) => +v.toFixed(2)),
          eye: b.eye.toArray().map((v) => +v.toFixed(2)),
          forward: b.forward.toArray().map((v) => +v.toFixed(2)),
          target: b.target?.id ?? null,
          hasSight: b.hasSight,
          heard: b.heard,
          lastKnown: b.lastKnown ? b.lastKnown.toArray().map((v) => +v.toFixed(2)) : null,
          pathLength: b.path.length,
          path: b.path.slice(0, 6).map((p) => p.toArray().map((v) => +v.toFixed(2))),
        })),
        viewmodelLoaded: !!viewmodel,
        viewmodelClips: viewmodel?.clips ?? [],
        viewmodelVisible: viewmodel?.root.visible ?? false,
        overlayActive: !!viewmodel,
        sceneChildren: engine.scene.children.length,
        viewmodelSceneChildren: viewmodel?.scene.children.length ?? 0,
        muzzleWorld: viewmodel
          ? viewmodel.muzzle.clone().applyMatrix4(engine.camera.matrixWorld).toArray().map((v) => +v.toFixed(3))
          : null,
        // ---- viewmodel alignment diagnostics ----
        viewmodelIdlePlaying: viewmodel?.idlePlaying ?? false,
        viewmodelBarrel: viewmodel?.alignment
          ? viewmodel.alignment.barrel.direction.toArray().map((v) => +v.toFixed(3))
          : null,
        viewmodelUp: viewmodel?.alignment
          ? viewmodel.alignment.up.direction.toArray().map((v) => +v.toFixed(3))
          : null,
        viewmodelNeck: viewmodel?.alignment
          ? viewmodel.alignment.neck.toArray().map((v) => +v.toFixed(3))
          : null,
        viewmodelMuzzleLocal: viewmodel
          ? viewmodel.muzzle.toArray().map((v) => +v.toFixed(4))
          : null,
        viewmodelSightLine: viewmodel
          ? viewmodel.sightLine.toArray().map((v) => +v.toFixed(4))
          : null,
        viewmodelRootPos: viewmodel
          ? viewmodel.root.position.toArray().map((v) => +v.toFixed(4))
          : null,
        viewmodelRootRot: viewmodel
          ? [
              +THREE.MathUtils.radToDeg(viewmodel.root.rotation.x).toFixed(2),
              +THREE.MathUtils.radToDeg(viewmodel.root.rotation.y).toFixed(2),
              +THREE.MathUtils.radToDeg(viewmodel.root.rotation.z).toFixed(2),
            ]
          : null,
        /**
         * The barrel direction in the VIEWMODEL CAMERA's space. After alignment
         * this must be very close to (0, 0, -1) — i.e. pointing straight at the
         * crosshair. This is the single number that proves the orientation is
         * right, so it is exposed rather than eyeballed.
         */
        barrelInCameraSpace: (() => {
          if (!viewmodel) return null;
          const dir = viewmodel.alignment?.barrel.direction;
          if (!dir) return null;
          // The barrel in root space, then through the root's own transform.
          const v = dir
            .clone()
            .applyQuaternion(viewmodel.orient.quaternion)
            .applyQuaternion(viewmodel.root.quaternion);
          return v.toArray().map((n) => +n.toFixed(3));
        })(),
        /** The muzzle, in the viewmodel camera's space. */
        muzzleInCameraSpace: viewmodel
          ? viewmodel.muzzle.toArray().map((v) => +v.toFixed(4))
          : null,
        /** Every mesh in the world scene, so a stray object can be identified. */
        worldMeshes: (() => {
          const out: { name: string; parent: string; visible: boolean; tris: number }[] = [];
          engine.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            const idx = m.geometry?.getIndex();
            out.push({
              name: m.name || '(unnamed)',
              parent: m.parent?.name || '(unnamed)',
              visible: m.visible,
              tris: Math.round((idx ? idx.count : m.geometry?.getAttribute('position')?.count ?? 0) / 3),
            });
          });
          return out;
        })(),
      }),
    },
  });

  // Compile every shader now, including the pooled muzzle flash and bullet
  // marks, so the first firefight does not stall on a compile.
  effects.warmup(() => engine.renderer.compile(engine.scene, engine.camera));

  // ---- click to play (pointer lock) ----
  setStatus(
    'Click to play — WASD move, Shift sprint, C crouch, Space jump, ' +
      'mouse aim, LMB fire, RMB aim, R reload, V inspect, Tab scoreboard, ' +
      'F3 debug, F4 viewmodel, ` settings.'
  );
  startBtn.disabled = false;

  /** Takes the pointer lock (which starts or resumes play). Must run in a click. */
  function lockPointer(onRefused?: () => void) {
    audio.resume();
    // Raw input: the OS pointer acceleration is switched off, so the same
    // mouse movement always turns the view by the same angle. Browsers or
    // platforms without it reject with NotSupportedError; fall back to a plain
    // lock then.
    type LockOptions = { unadjustedMovement?: boolean };
    const lock = canvas.requestPointerLock as unknown as (o?: LockOptions) => Promise<void> | undefined;
    const request = lock.call(canvas, { unadjustedMovement: true });
    request?.catch((err: DOMException) => {
      if (err?.name === 'NotSupportedError') {
        lock.call(canvas)?.catch(() => onRefused?.());
      } else {
        onRefused?.();
      }
    });
  }

  startBtn.addEventListener('click', () => lockPointer());

  /** Back to the start screen with a fresh match waiting behind it. */
  function goToMainMenu() {
    matchEnd.hide();
    pauseMenu.hide();
    settings.hide();
    credits.hide();
    resetMatch();
    started = false;
    if (document.pointerLockElement) document.exitPointerLock();
    bootEl.classList.remove('boot--hidden');
  }

  // ---- end of match: PLAY AGAIN / MAIN MENU (auto after 30 s) ----
  const matchEnd = createMatchEndScreen({
    onPlayAgain() {
      matchEnd.hide();
      resetMatch();
      // If the browser refuses the lock (too soon after it was released),
      // the pause menu takes over with its own "click RESUME" hint.
      lockPointer(() => {
        pauseMenu.show();
        pauseMenu.resumeRefused();
      });
    },
    onMainMenu: goToMainMenu,
  });

  // ---- Esc: pause menu, not the boot screen ----
  const pauseMenu = createPauseMenu({
    onResume() {
      settings.hide();
      credits.hide();
      lockPointer(() => pauseMenu.resumeRefused());
    },
    onSettings() {
      settings.show();
    },
    onCredits() {
      credits.show();
    },
    onQuit: () => goToMainMenu(),
  });

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (locked) started = true;
    bootEl.classList.toggle('boot--hidden', locked || started);
    if (locked) pauseMenu.hide();
    // Losing the mouse at the end of a match is the end screen's doing.
    else if (started && !match.over && !matchEnd.visible) pauseMenu.show();
  });

  // Esc with the mouse already free closes whatever sits over the pause menu.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || !started || document.pointerLockElement === canvas) return;
    if (settings.visible) settings.hide();
    else if (credits.visible) credits.hide();
  });

  // ---- credits, reachable from the boot screen ----
  const creditsBtn = document.getElementById('boot-credits') as HTMLButtonElement | null;
  creditsBtn?.addEventListener('click', () => credits.show());
}

/** Angle from the player's facing to the attacker, for the damage indicator. */
function angleToAttacker(attacker: Combatant | null): number {
  if (!attacker) return 0;
  const game = (window as unknown as { __GAME__?: { player?: { position: THREE.Vector3; yaw: number } } })
    .__GAME__;
  const player = game?.player;
  if (!player) return 0;
  const dx = attacker.position.x - player.position.x;
  const dz = attacker.position.z - player.position.z;
  // The player faces -Z at yaw 0, so the bearing is measured from that axis.
  const bearing = Math.atan2(dx, -dz);
  return bearing - player.yaw;
}

function setStatus(text: string) {
  statusEl.textContent = text;
}

main().catch((err) => {
  console.error('[game] fatal:', err);
  setStatus(`Failed to start: ${(err as Error).message}`);
});
