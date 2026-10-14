/**
 * Central tunables. Every magic number that a designer might want to tweak
 * lives here so gameplay code stays readable.
 */

export const PLAYER = {
  /** Standing capsule total height, metres. */
  height: 1.8,
  /**
   * Capsule radius, metres.
   *
   * 0.35 rather than the 0.34 this started at, because the clearance the CAMERA
   * gets from a wall is not this number. The eye sits at 1.65 m, which is inside
   * the capsule's TOP HEMISPHERE, where the horizontal radius has already shrunk
   * — see `CAMERA.near` for the arithmetic. Every centimetre of radius here is
   * worth less than a centimetre of eye clearance.
   */
  radius: 0.35,
  /** Crouched capsule total height, metres. */
  crouchHeight: 1.15,
  /** Eye offset from feet when standing. */
  eyeHeight: 1.65,
  /** Eye offset from feet when crouched. */
  crouchEyeHeight: 1.1,
  /**
   * Half-life of the standing <-> crouched eye-height blend, seconds.
   *
   * The camera is the only thing that moves when the player crouches — there is
   * no visible body — so this blend IS the crouch feedback. Snapping between the
   * two heights would read as a teleport.
   */
  eyeTransitionHalfLife: 0.09,

  walkSpeed: 3.7,
  sprintSpeed: 6.4,
  crouchSpeed: 1.9,
  /**
   * Time to reach the target ground speed from a standstill, seconds.
   *
   * Time-based rather than acceleration-based, so walking (3.7 m/s) and
   * sprinting (6.4 m/s) both spin up in the same, tunable time instead of
   * sprinting feeling sluggish. 0.12 s reads as weight without feeling mushy.
   */
  accelTime: 0.12,
  /**
   * Time to come to a full stop from full speed, seconds.
   *
   * Slightly longer than `accelTime`: stopping should feel like the character
   * has mass, while starting should feel responsive.
   */
  decelTime: 0.14,
  /** Reduced control while airborne (m/s^2). */
  airAccel: 10,
  jumpVelocity: 5.0,
  gravity: -22,
  /** Downward speed cap, prevents tunnelling at terminal velocity. */
  maxFallSpeed: -45,
  /** Time after jumping during which the ground check is ignored. */
  jumpGraceTime: 0.15,
  /** Time after walking off a ledge during which a jump still works. */
  coyoteTime: 0.12,
} as const;

export const CAMERA = {
  /** World field of view, degrees. */
  fov: 75,
  /** World field of view while aiming down sights, degrees. */
  adsFov: 55,
  /**
   * The WORLD camera's near plane, metres.
   *
   * ## This was 0.3, and that was the "camera goes inside the container" bug
   *
   * The near plane clips everything closer than it, so the camera must never be
   * closer to a wall than this value. It was set to 0.3 m on the assumption that
   * the player's capsule radius (0.34 m) was the camera's clearance from a wall.
   * It is not, and the difference is the whole bug.
   *
   * The eye is at 1.65 m. The capsule centre is at 0.9 m and its cylindrical
   * section ends at 0.9 + (0.9 - 0.34) = 1.46 m. So the eye sits 0.19 m up inside
   * the capsule's TOP HEMISPHERE, where the horizontal radius has already shrunk:
   *
   *     sqrt(0.34^2 - 0.19^2) = 0.282 m
   *
   * Add the character controller's 0.02 m skin and the camera's real minimum
   * distance to a container face is 0.302 m — two millimetres outside a 0.3 m
   * near plane. Press into a container and the near plane slices through its
   * wall, which is exactly the reported symptom: you see the inside of the
   * container and straight out the other side.
   *
   * 0.05 m leaves a 0.25 m margin, and the viewmodel is unaffected because it is
   * rendered by its own camera with its own near plane (`SELF_CLIP` in
   * `viewmodel.ts`, 0.12 m — the weapon is authored with the eye inside its own
   * receiver, so it needs a much larger one).
   *
   * `eyeWallClearance()` in `player.ts` computes the figure above from the config
   * and is logged at startup, so this can never silently drift out of agreement
   * again.
   */
  near: 0.05,
  far: 400,
  pitchMin: (-88 * Math.PI) / 180,
  pitchMax: (88 * Math.PI) / 180,
  /** Radians per pixel of mouse movement. */
  sensitivity: 0.0022,
  /** Multiplier applied while aiming down sights. */
  adsSensitivityScale: 0.55,
  /** Smoothing half-life for the eye position, seconds. */
  followHalfLife: 0.045,
  /** Seconds to blend between the hip and ADS field of view. */
  adsFovHalfLife: 0.06,
  /**
   * Half-life of the hip <-> ADS hold blend, seconds.
   *
   * 0.06 s covers ~90% of the transition in 0.2 s, which is the "smooth but not
   * sluggish" scope-in a shooter wants. Shared by the camera's FOV zoom and the
   * viewmodel's hold so the two cannot drift apart.
   */
  adsHalfLife: 0.06,
  /**
   * Camera bob. Deliberately tiny.
   *
   * The weapon carries the motion — see `VIEWMODEL.bob` — and the camera only
   * hints at it. Anything more reads as the player bouncing on every footstep,
   * which is exactly the complaint this replaces.
   *
   * The rate is a footstep CADENCE, not a distance: see `src/player/gait.ts`.
   */
  bob: {
    /** Vertical travel at a full walk, metres (0.4 cm). */
    walkAmplitude: 0.004,
    /** Vertical travel at a full sprint, metres (0.7 cm). */
    sprintAmplitude: 0.007,
    /** Footsteps per second at walking speed. Real people: ~1.8-2.2. */
    walkCadence: 2.1,
    /** Footsteps per second at full sprint. Real runners: ~2.6-3.0. */
    sprintCadence: 2.7,
    /** Multiplier applied by the "Normal" setting. "Low" is 1x, "Off" is 0. */
    normalScale: 2,
  },
  /**
   * Vertical smoothing, so sub-centimetre physics corrections never reach the
   * screen.
   *
   * Applied ONLY while the eye's own vertical movement is below
   * `verticalSmoothThreshold` per frame. A plain lerp would lag a jump by
   * `v * halfLife / ln 2` — 18 cm at jump speed — so smoothing switches itself
   * off the moment the player is genuinely moving vertically.
   */
  verticalSmoothHalfLife: 0.03,
  verticalSmoothThreshold: 0.02,
} as const;

/**
 * The first-person viewmodel.
 *
 * `ak74u__free_animation..glb` is a pair of arms holding an AK-74U — a
 * first-person viewmodel, and the ONLY thing the player is drawn as. Exactly one
 * instance exists in the whole game.
 *
 * It is rendered by a second camera into a second scene that is composited over
 * the world with the depth buffer cleared in between, so the weapon can never
 * clip into a wall or a container no matter how close the player stands to one.
 * See `src/weapons/viewmodel.ts` and `Engine.setOverlay`.
 *
 * Every transform below is tuned visually with the F4 tool
 * (`src/weapons/viewmodelDebug.ts`), which prints a paste-ready replacement for
 * this block. Rotations are in DEGREES, because that is what the tool prints.
 */
export const VIEWMODEL = {
  /** The supplied arms + AK-74U. */
  url: `${import.meta.env.BASE_URL}models/ak74u__free_animation..glb`,
  /**
   * Field of view the viewmodel is rendered with.
   *
   * Narrower than the world FOV on purpose: a wide FOV on an object 0.4 m from
   * the eye stretches the weapon badly at the screen edges.
   */
  fov: 55,
  near: 0.01,
  far: 5,
  /**
   * The gun mesh is normalised so its longest POSED dimension is this many
   * metres — the real AK-74U's 0.73 m. The asset is authored in its own units,
   * so this is what makes it usable without editing the file.
   *
   * Normalising the GUN rather than the whole model matters: the arms reach
   * further than the barrel does, so normalising the whole thing would make the
   * weapon's apparent size depend on the animation pose.
   */
  gunLength: 0.73,
  /**
   * Materials to hide once the viewmodel is loaded.
   *
   * Empty, and it should stay that way. An earlier revision hid `Magazine` here
   * on the strength of a note claiming it was "1.77 m of leftover body geometry".
   * That measurement was taken in BIND pose, where a skinned mesh's bounds mean
   * nothing — the vertices are still at the authoring skeleton's rest positions,
   * not where the bones put them. Re-measured on the POSED IDLE skeleton, the
   * `Magazine` mesh is exactly what its name says: the weapon's own magazine,
   * 10,240 tris in two cleanly separable halves —
   *
   *   carg_044   5,120 tris  the inserted magazine, skinned to a child of the
   *                          gun bone `Bone_043`, so it rides the weapon
   *   carg2_048  5,120 tris  the stowed spare magazine
   *
   * Hiding it is why reloading showed no magazine: the clip animates a magazine
   * that was never drawn. It is now visible.
   *
   * Matched case-insensitively against the material name, and logged on load so a
   * silent mismatch cannot go unnoticed.
   */
  hideMaterials: [] as string[],
  /**
   * Where the model's `Neck` bone is placed, in the viewmodel camera's space.
   *
   * The rig was authored with the camera at the neck — that is how a
   * first-person arms model is built, since the neck is where a head would be.
   * Placing the Neck here is what puts the arms in front of the eye at a
   * believable distance instead of inside the player's skull.
   *
   * Slightly behind and above the camera origin, so the shoulders sit off the
   * bottom of the screen and the hands reach forward into view.
   */
  anchor: { x: 0, y: 0.06, z: 0.1 },
  /**
   * Manual nudge composed ON TOP of the auto-measured alignment, in DEGREES.
   *
   * The barrel/sights alignment is derived from the posed geometry at load (see
   * `viewmodelAlign.ts`), so this should normally stay at zero. It exists for
   * the case where a future asset's magazine is not a reliable "down" reference
   * and the automatic result needs a few degrees of correction.
   */
  orient: {
    rotation: { x: 0, y: 0, z: 0 },
  },
  /** Multiplier on top of the normalisation.
   *
   * A first-person viewmodel is not drawn at true scale — a real 0.73 m rifle
   * held 0.45 m from the eye would be larger than the screen. This brings it
   * down to the size a player expects to see.
   */
  scale: 1,
  /**
   * Aim-down-sights hold: the iron sights must land on the screen centre.
   *
   * `sightAlign` solves BOTH halves of that from the measured sights:
   *
   *  - **rotation** — the minimal rotation that brings the line from the rear
   *    sight to the front post onto the camera's own -Z axis. Without it the
   *    sights are only parallel to the bore, and any difference between the two
   *    sight heights leaves the camera looking at the receiver instead of
   *    through the notch.
   *  - **position.x / position.y** — the slide that puts the front post exactly
   *    on the screen centre after that rotation.
   *
   * Both are logged at load with the measured points, so a wrong solve is
   * visible in the console rather than only on screen.
   *
   * `position.z` is deliberately NOT solved. It is the one value that must be
   * set by eye, and it matters more than it looks.
   *
   * The gun is 0.73 m long and spans root-space z from +0.186 (the stock) to
   * -0.544 (the muzzle). The root's own z shifts all of that: a point at root z
   * `p` sits at camera z `p + z`, so the receiver's distance from the eye is
   * `-(p + z)`. More negative z therefore pushes the weapon AWAY, while the stock
   * stays just behind the eye — which is where an aiming eye actually is.
   *
   *   z = -0.02  receiver ~0.2 m ahead, fills the screen  (too close)
   *   z = -0.22  stock 3.4 cm in front of the eye, staring at the butt
   *   z = -0.16  stock 2.6 cm behind the eye, receiver 0.51 m ahead  <-- this
   */
  ads: {
    sightAlign: true,
    position: { x: 0, y: 0, z: -0.16 },
    rotation: { x: 0, y: 0, z: 0 },
  },
  /**
   * Hip-fire hold: lower right of the screen, both hands visible on the weapon.
   *
   * With `autoFromAds` the hold is the solved ADS hold plus `offset`, so it
   * tracks the weapon's real geometry instead of fighting it — the gun is always
   * the same distance below and right of the sights, whatever the asset.
   */
  hip: {
    autoFromAds: true,
    offset: { x: 0.055, y: -0.05, z: 0.045 },
    rotationOffset: { x: 0, y: -3, z: 0 },
    position: { x: 0.055, y: -0.095, z: -0.115 },
    rotation: { x: 0, y: -3, z: 0 },
  },
  /**
   * Crossfade lengths per clip, seconds.
   *
   * `reload` is deliberately tiny. The rifle is skinned to its OWN bones, so a
   * crossfade between two clips is a weighted average of two different gun
   * positions — the weapon visibly drifts out of the hands mid-blend. Reload
   * therefore switches in under 0.05 s, which reads as instant without a hard
   * pop in the mixer's weight bookkeeping.
   */
  clipFade: {
    draw: 0.05,
    shoot: 0.02,
    reload: 0.02,
    inspect: 0.08,
    holster: 0.05,
    /** Fade back onto the idle loop when a one-shot finishes. */
    idle: 0.1,
  },
  /**
   * Reload behaviour.
   *
   * The DURATION is not here: it comes from the clips themselves (RELOAD1 and
   * RELOAD2 are different lengths, and squeezing the long one into the short
   * one's time is very visible). Only the point at which the magazine is seated
   * is a tunable, because that cannot be read off the clip's length.
   */
  reload: {
    /**
     * When things happen in each reload clip, in seconds of clip time.
     *
     * MEASURED, not guessed: the rifle in the viewmodel GLB has its own animated
     * bones — `carg` (cargador, the magazine), `seg` (the release lever) and
     * `recam` (recamara, the bolt) — and these are the times those bones move.
     * Re-measure with `node tools/reload-events.mjs <file.glb>` if the viewmodel
     * changes. The reload sounds and the ammo refill are both driven from these,
     * so what you hear and what the counter does match what the hands do.
     */
    events: {
      RELOAD1: { duration: 2.23, release: 0.4, magOut: 0.43, magIn: 1.47 },
      RELOAD2: { duration: 3.47, release: 0.3, magOut: 0.33, magIn: 1.27, boltBack: 2.2, boltForward: 2.47 },
    },
    /**
     * Fraction of the clip at which the ammo counter refills, for RELOAD1:
     * the moment the new magazine seats.
     */
    refillAtTactical: 1.47 / 2.23,
    /**
     * Same for RELOAD2, the empty reload: when the bolt goes forward and the
     * rifle can actually fire again, not merely when the magazine seats.
     */
    refillAtEmpty: 2.47 / 3.47,
    /**
     * Bob and sway are scaled to this while a reload plays.
     *
     * The reload clip already moves the arms deliberately; letting the walk bob
     * ride on top of it drags the hands off the magazine well.
     */
     bobScale: 0.3,
    swayScale: 0.3,
  },
  /**
   * Correction added to the muzzle position derived from the gun mesh at load.
   * The derivation takes the tip of the barrel, which is right in almost every
   * case; this exists for the case where it is not.
   */
  muzzleOffset: { x: 0, y: 0, z: 0 },

  /** Weapon bob while walking, driven by distance travelled rather than time. */
  bob: {
    /** Vertical travel at a full walk, metres. */
    amplitude: 0.012,
    /** Multiplier while sprinting. The rate comes from `CAMERA.bob`'s cadence. */
    sprintScale: 1.4,
    /** Lateral figure-eight width, as a fraction of the vertical amplitude. */
    lateralScale: 0.7,
  },

  /** Sway: the weapon lags slightly behind the mouse, then settles. */
  sway: {
    /** Metres of travel per pixel of mouse movement. */
    positionPerPixel: 0.0004,
    /** Degrees of roll per pixel of mouse movement. */
    rollPerPixel: 0.022,
    /** Hard caps, so a fast flick cannot throw the gun off screen. */
    maxOffset: 0.055,
    maxRoll: 7,
    /** Half-life of the return to centre, seconds. */
    returnHalfLife: 0.075,
  },

  /** Per-shot kick, layered on top of the camera's own recoil. */
  kick: {
    /** Metres the weapon is pushed back toward the camera per shot. */
    back: 0.022,
    /** Degrees of muzzle rise per shot. */
    pitch: 1.2,
    /** Degrees of random roll per shot. */
    roll: 0.9,
    /** Half-life of the recovery, seconds. */
    recoverHalfLife: 0.05,
  },
} as const;

export const LEVEL = {
  /** Path of the supplied warehouse model. */
  url: `${import.meta.env.BASE_URL}models/warehouse_fbx_model_free.glb`,
  /**
   * The model is used at its authored size — 16.0 m wide x 46.27 m deep
   * x 5.02 m tall. It is NOT scaled toward the 60 x 40 m in the original brief;
   * a long narrow hall is the arena, and the cover layout is built for it.
   */
  scale: 1,
  /** Mesh names that must never generate colliders. */
  nonCollidingMaterials: ['Emissive'],
  /** Material whose mesh becomes the structural trimesh collider. */
  structuralMaterial: 'Metal',
  /** Material of the flat 2-triangle floor quad. */
  floorMaterial: 'WetConcrete',
  /** Thickness of the generated floor slab collider, metres. */
  floorThickness: 0.4,

  // ---- floor surface appearance -------------------------------------------------
  // The supplied floor material is called "WetConcrete" and ships with a
  // roughness map that makes it read as a mirror. We override it to matte
  // concrete: high roughness, zero metalness, and the wet-look maps dropped.
  floorRoughness: 0.9,
  floorMetalness: 0,
  /** Lowered so the floor does not pick up a glossy HDRI sheen. */
  floorEnvMapIntensity: 0.3,
  /** Drops roughnessMap/metalnessMap, which carry the wet look in the texture. */
  floorDropWetMaps: true,
} as const;

export const COVER = {
  /** Shipping container, 20 ft ISO. X/Z are the footprint, Y the height.
   *  NOTE: the long axis (6.06 m) is on X at rotY = 0. */
  container: { x: 6.06, y: 2.59, z: 2.44 },
  /** Standard pallet crate. */
  crate: { x: 1.2, y: 1.2, z: 1.2 },
  /** Pallet racking bay: 1.2 m deep, 2.8 m tall, 3.0 m long.
   *  Kept to 3.0 m (not the 3.8 m of a real bay) so it fits the gaps between
   *  the spawn wall and the flank blockers without intersecting either. */
  rack: { x: 1.2, y: 2.8, z: 3.0 },
  /** Gaps narrower than this are treated as impassable by the bot navmesh. */
  minPassableGap: 1.0,
  /**
   * Vertical clearance required between a cover object's top and the arched
   * roof above it. The roof falls to ~3.0 m at the walls, so tall cover near a
   * wall is the case this guards.
   */
  roofClearance: 0.15,
} as const;

export const CHARACTER = {
  /**
   * A Mixamo-rigged soldier, if the project owner has downloaded one.
   * See docs/MIXAMO-SETUP.md. When this file is absent the game falls back to
   * the procedural blockout rig in src/characters/rig.ts — same bone names,
   * same interface, so nothing downstream changes.
   *
   * Used for BOTS ONLY. The player is a first-person viewmodel and has no body.
   */
  soldierUrl: `${import.meta.env.BASE_URL}models/futuristic_soldier_free.glb`,
  /** Height every character is normalised to, metres. */
  height: 1.8,
  /** Uniform scale applied to the soldier if it loads in the wrong units. */
  soldierFallbackScale: 1,

  /**
   * Animation. See src/characters/animation.ts.
   *
   * `clips` maps each game slot to the clip name inside the soldier GLB. A slot
   * whose clip is missing falls back down a chain (fire -> aim -> idle, run ->
   * walk, ...), so a model with fewer clips still animates.
   */
  animation: {
    clips: {
      idle: 'idleWgun',
      aim: 'shooting',
      fire: 'rapidShooting',
      walk: 'walk',
      run: 'run',
      runFire: 'runAndShooting',
      back: 'backpaddle',
      strafeLeft: 'strafeLeft',
      strafeRight: 'strafeRight',
      reload: 'reload',
      death: 'death',
      crouch: 'crouch',
      crouchWalk: 'crouchWalk',
    },
    /** Crossfade between clips, seconds. */
    fade: 0.22,
    /** Faster blend into and out of the aim/fire pose, so the gun comes up quickly. */
    aimFade: 0.12,
    /** Death blends in fast: a hit body does not ease into a fall. */
    deathFade: 0.08,
    /** Below this ground speed (m/s) the character is treated as standing. */
    moveThreshold: 0.35,
    /** Clamp on locomotion playback rate when matching clip speed to ground speed. */
    minTimeScale: 0.6,
    maxTimeScale: 2.0,
    /** Seconds the firing pose is held after the last shot. */
    fireHold: 0.35,
    /** Largest spine tilt toward a target above or below, radians. */
    maxAimPitch: 0.6,
    /** Angular velocity of the hit flinch, radians/second. */
    flinchKick: 4.5,
  },
} as const;

export const RIFLE = {
  /**
   * Optional third-person rifle model, carried by the BOTS.
   *
   * Drop a low-poly AK-style rifle GLB at this path and it is used
   * automatically; until then a procedural placeholder built from boxes is
   * used. See docs/MIXAMO-SETUP.md for what to download.
   *
   * The supplied `ak74u__free_animation..glb` is deliberately NOT used here:
   * its rifle is 49,666 triangles, so 8 characters would carry ~400k triangles
   * of gun — more than the entire level. It is used for the first-person
   * viewmodel instead, where exactly one instance exists.
   */
  modelUrl: `${import.meta.env.BASE_URL}models/rifle.glb`,
  /** Real AK-74U overall length, metres. Whatever loads is scaled to this. */
  length: 0.73,
  /** Bone the rifle is welded to. Mixamo namespaces are stripped before lookup. */
  handBone: 'RightHand',
  /**
   * Grip transform in the hand bone's local space.
   *
   * This cannot be derived from first principles — Mixamo hand bones carry
   * their own axis convention and it differs between rigs — so it is tuned
   * visually instead. Press F5 in game to nudge it live; the tool prints a
   * ready-to-paste replacement for this block.
   *
   * Rotation is in DEGREES, because that is what the tool prints and what is
   * readable in a config file.
   */
  grip: {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: 1,
  },
} as const;

export const TEAM = {
  blue: {
    name: 'BLUE',
    accent: 0x3b82f6,
    accentDark: 0x1d4ed8,
    /** Spawn zone centre, world space (level is centred on the origin). */
    spawnCenter: { x: 0, y: 0, z: -15.6 },
  },
  red: {
    name: 'RED',
    accent: 0xef4444,
    accentDark: 0xb91c1c,
    spawnCenter: { x: 0, y: 0, z: 15.6 },
  },
} as const;

export type TeamId = keyof typeof TEAM;

export const SPAWN = {
  /**
   * Spawn zone half-depth along Z.
   *
   * The zone spans z = centre +/- this. With the centre at -/+15.6 and a
   * half-depth of 2.4 the zone ends at z = -/+13.2, which clears the pallet
   * racking at z = -/+11.5 (whose near edge is at 13.0) by 0.2 m. A player must
   * never spawn inside a prop — the cover validator enforces this.
   */
  halfDepth: 2.4,
  /** Spawn zone half-width as a fraction of the usable half-width (8 - 1.2). */
  widthFraction: 0.85,
  /** Seconds of invulnerability after respawning. */
  protectionTime: 2.0,
  /** Seconds between death and respawn. */
  respawnDelay: 3.0,
} as const;

export const MATCH = {
  /** First team to this many kills wins. */
  killLimit: 40,
  /** Match length in seconds; the higher score wins when it expires. */
  timeLimit: 300,
  /** The player fights alone (BLUE) against this many enemy bots (RED). */
  enemyCount: 4,
} as const;

/**
 * Bot AI tunables.
 *
 * Bots use the SAME weapons, hitscan, spread, magazine and reload as the player
 * — `createWeapon()` and `combat.fire()` are shared, not reimplemented. Nothing
 * here lets a bot do something the player cannot: no seeing through walls, no
 * perfect aim, no infinite ammo. What lives here is only the *human* layer on
 * top: how long it takes to notice, how badly it shoots at first, and how it
 * walks.
 */
export const BOT = {
  /** Capsule radius, metres. Matches the player so both use the same cover. */
  radius: 0.34,
  /** Body height, metres. */
  height: 1.8,
  /** Eye offset from the feet, metres. */
  eyeHeight: 1.62,
  /**
   * Patrol speed, m/s. A tactical walk: slower than the player's walk so bots
   * can be outrun, and close to the walk clip's natural pace so the legs match
   * the ground speed instead of scurrying.
   */
  walkSpeed: 1.5,
  /** Speed while moving to a remembered position or a flank, m/s. */
  sprintSpeed: 5.2,
  /** Ground acceleration, m/s^2. */
  accel: 14,
  /** Turn rate while patrolling, radians/second. */
  turnRate: 7,
  /** Turn rate while engaging, radians/second. Faster so aim tracks. */
  turnRateEngaged: 11,
  /** How close to a path waypoint counts as reached, metres. */
  waypointRadius: 0.6,
  /** Seconds between path recomputations while following a moving target. */
  repathInterval: 0.45,

  /**
   * Perception.
   *
   * Evaluated at `updateHz`, NOT every frame, and staggered per bot. Seven bots
   * each casting a ray every frame is 420 casts a second for information that
   * changes at a human timescale; at 10 Hz staggered it is 70, and the player
   * cannot tell the difference.
   */
  perception: {
    /** Full vision cone angle, degrees. 100 means +/-50 from the facing. */
    fovDeg: 100,
    /** Maximum sight distance, metres. */
    range: 40,
    /**
     * Gunfire is heard within this radius, metres. The hall is a closed steel
     * shed 46 m long, so a rifle shot carries end to end — 25 m left the far
     * spawn deaf to a fight at the other end.
     */
    hearRadius: 48,
    /** Evaluations per second, per bot. */
    updateHz: 10,
    /** How long a bot keeps chasing a remembered position, seconds. */
    memoryTime: 5,
    /**
     * Vertical tolerance of the vision cone, as a cosine.
     *
     * The cone is a cone in 3D, not a horizontal wedge: a bot on the floor must
     * not "see" a player standing on top of a container directly above it.
     */
    cosTolerance: 0.35,
  },

  /**
   * Human-like aiming.
   *
   * The bot's aim error is a cone half-angle in DEGREES that starts wide when a
   * target is first acquired and tightens over `tightenTime` seconds of
   * continuous sight. That is what makes the first shots miss and the later ones
   * land, without ever giving the bot a perfect shot.
   */
  aim: {
    /** Reaction delay before the first shot after acquiring a target, seconds. */
    reactionMin: 0.3,
    reactionMax: 0.5,
    /** Aim error when a target is first acquired, degrees. */
    initialError: 8,
    /** Aim error after converging, degrees. Never zero: bots are not aimbots. */
    minError: 1.1,
    /** Seconds of continuous sight to converge from initial to minimum. */
    tightenTime: 1.0,
    /** Aim error multiplier while the bot is moving. */
    movingScale: 2.1,
    /** Aim error multiplier while the bot is crouched. */
    crouchScale: 0.7,
    /** Vertical aim point above the target's capsule centre, metres. */
    aimHeight: 0.35,
  },

  /** Burst fire. Bots do not hold the trigger down. */
  burst: {
    /** Shots per burst, inclusive range. */
    min: 3,
    max: 6,
    /** Pause between bursts, seconds. */
    pauseMin: 0.35,
    pauseMax: 0.95,
  },

  /** Patrol behaviour. */
  patrol: {
    /** Radius of the random navmesh point searched around the bot, metres. */
    wanderRadius: 14,
    /** Seconds spent standing still at a patrol point before moving on. */
    idleMin: 0.5,
    idleMax: 2.0,
    /** A patrol point further than this from the last one is preferred. */
    minTravel: 6,
  },

  /**
   * Tactics. See the state machine in src/bots/bot.ts.
   */
  tactics: {
    /** Sideways speed while fighting, m/s. Slowed to 30% while a burst fires. */
    strafeSpeed: 2.3,
    /** Seconds between strafe direction changes. */
    strafeSwitchMin: 0.45,
    strafeSwitchMax: 1.3,
    /** Preferred fighting distance, metres: close in beyond max, back off inside min. */
    rangeMin: 6,
    rangeMax: 20,
    /** Speed while moving up on a last known position, weapon raised, m/s. */
    pushSpeed: 2.4,
    /** Cap on how long a heard sound is remembered for travel, seconds. */
    maxInvestigateTravel: 20,
    /** Within this distance of a suspected enemy, a moving bot aims at it. */
    preAimRange: 14,
    /** Below this health, a bot that is being hit breaks for cover. */
    coverHealth: 60,
    /** Below this health with no cover in reach, a bot backs away. */
    retreatHealth: 30,
    /** How far a bot will run to reach cover, metres. */
    coverSearchRadius: 14,
    /** Never take cover closer than this to the threat, metres. */
    coverMinThreatDistance: 4,
    /** Seconds spent hidden at cover before peeking. */
    coverHoldMin: 0.9,
    coverHoldMax: 2.2,
    /** Seconds of exposure while peeking before ducking back. */
    peekMin: 1.4,
    peekMax: 3.0,
    /** Props lower than this are crouched behind and shot over, metres. */
    lowCoverHeight: 1.45,
    /** Eye height while crouched, metres. Low enough to hide behind a crate. */
    crouchEyeHeight: 1.0,
    /** How far sideways of the last known position a flank swings, metres. */
    flankOffset: 6,
    /** A teammate's callout brings help from this far, metres. */
    calloutRadius: 25,
    /** Reload during lulls once the magazine is below this fraction. */
    tacticalReloadFraction: 0.5,
    /** A teammate closer than this to the line of fire stops the trigger, metres. */
    friendlyClearance: 0.7,
    /** Player footsteps are heard within these radii, metres. */
    footstepHearWalk: 6,
    footstepHearSprint: 15,
  },

  /**
   * Squad coordination. The bots on a team share what they see over the radio
   * and split into roles. See the Squad section of src/bots/bot.ts.
   */
  squad: {
    /** Seconds a sighting stays actionable for the whole squad. */
    intelTTL: 7,
    /** The target's motion is extrapolated at most this far ahead, seconds. */
    predictTime: 1.5,
    /** At most this many bots pin the target; the rest flank. */
    maxPinners: 2,
    /** Flankers sprint until this close to the target, then walk in aiming, metres. */
    flankSlowRange: 6,
    /** A flank route must keep at least this far from the target, metres. */
    flankClearance: 3.5,
    /** Flankers approach from this far out, metres... */
    flankRadius: 8,
    /** ...at these angles from the pinners' line of attack, degrees. */
    flankAngles: [100, -100, 180, 55, -55],
    /** A pinner holds its angle this long after the last sighting, seconds. */
    holdTime: 3.5,
    /** Suppressive fire continues this long after the target ducks, seconds. */
    suppressWindow: 2.5,
    suppressRange: 32,
    /** Suppress only if the shot lands within this of the target's spot, metres. */
    suppressReach: 3,
    /** The player reloading is heard, and rushed, within this radius, metres. */
    reloadHearRadius: 22,
    /** A bot inside this angle of the player's aim knows it is being aimed at, degrees. */
    aimedAtDeg: 5,
    /** Bots keep at least this far apart while moving, metres. */
    separation: 1.8,
    /** Search zones rotate between bots this often, seconds. */
    searchRotate: 12,
    /** Roles are re-assigned this often, seconds. */
    roleInterval: 0.5,
  },

  /** Death: bots fall over rather than vanishing. */
  death: {
    /** Seconds the fall takes. */
    fallTime: 0.45,
    /** Degrees the body pitches forward as it falls. */
    fallAngle: 88,
  },
} as const;

export const COMBAT = {
  maxHealth: 100,
  /** Headshots multiply damage by this. */
  headshotMultiplier: 2,
  /** When false, rounds pass harmlessly through teammates. */
  friendlyFire: false,
  /** Seconds a corpse stays on the ground before it is removed. */
  corpseTime: 6,
} as const;

/**
 * Weapon definitions.
 *
 * Spread and recoil are in DEGREES. `spread` is a half-angle: the shot is
 * displaced by a random point inside a cone of that half-angle.
 *
 * `reloadTime` is the FALLBACK only. When a viewmodel supplies a clip for the
 * weapon, the clip's own length drives the reload — see `VIEWMODEL.reload`.
 */
export const WEAPONS = {
  rifle: {
    id: 'rifle',
    name: 'AK-74U',
    /** Damage per bullet to the body. */
    damage: 24,
    /** Rounds per minute. */
    rpm: 600,
    magazine: 30,
    reloadTime: 2.2,
    /** Hitscan range, metres. */
    range: 120,
    /** Automatic: holding the trigger keeps firing. */
    automatic: true,
    spread: {
      /** Half-angle when standing still, not aiming. */
      base: 0.45,
      /** Half-angle while aiming down sights. */
      ads: 0.12,
      /** Multiplier while crouching. */
      crouchScale: 0.6,
      /** Added half-angle per m/s of horizontal speed. */
      movePerSpeed: 0.28,
      /** Added half-angle per shot fired, decays at `recover` per second. */
      perShot: 0.5,
      /** Hard cap. */
      max: 5.5,
      recover: 5.0,
    },
    recoil: {
      /** Degrees of upward kick per shot. */
      vertical: 0.62,
      /** Degrees of random horizontal kick per shot. */
      horizontal: 0.22,
      /** Fraction of accumulated recoil recovered per second. */
      recover: 7.0,
      /** Cap on accumulated vertical recoil, degrees. */
      maxVertical: 9,
    },
  },
  smg: {
    id: 'smg',
    name: 'MP-5',
    damage: 15,
    rpm: 900,
    magazine: 35,
    reloadTime: 1.9,
    range: 90,
    automatic: true,
    spread: {
      base: 0.85,
      ads: 0.3,
      crouchScale: 0.65,
      movePerSpeed: 0.36,
      perShot: 0.42,
      max: 6.5,
      recover: 6.0,
    },
    recoil: {
      vertical: 0.34,
      horizontal: 0.3,
      recover: 8.0,
      maxVertical: 6,
    },
  },
} as const;

export type WeaponId = keyof typeof WEAPONS;

/**
 * Order the number keys select weapons in.
 *
 * The SMG is defined above but deliberately NOT listed: there is only one
 * first-person viewmodel, and a weapon the player can switch to but cannot see
 * is worse than one they cannot switch to. Add `'smg'` back here once a second
 * viewmodel exists at `VIEWMODEL.url`.
 */
export const WEAPON_ORDER: WeaponId[] = ['rifle'];

export const RENDER = {
  /** Device pixel ratio cap; keeps fill rate sane on high-DPI laptops. */
  maxPixelRatio: 1.75,
  shadowMapSize: 2048,
} as const;

export const AUDIO = {
  /** Master volume, 0..1. */
  master: 0.7,
  /** Distance at which positional sounds are fully attenuated, metres. */
  refDistance: 3,
  /** Distance beyond which positional sounds are inaudible, metres. */
  maxDistance: 90,
  /** Gunfire is audible to bots within this radius, metres. */
  gunshotHearRadius: 45,
} as const;
