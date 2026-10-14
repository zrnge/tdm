# Mixamo setup — the soldier character and its animations

The supplied `ak74u__free_animation..glb` is a **first-person viewmodel** (arms
+ rifle, no torso/legs), so it cannot be the third-person character. Until a
real humanoid is dropped in, the game uses a procedural blockout rig with the
same Mixamo bone names, so **nothing is blocked** — but it looks like a blockout.

This page tells you exactly what to download to replace it. No code changes are
needed: drop the files in and reload.

---

## 1. The character (one file)

Go to <https://www.mixamo.com/> (free Adobe account), open the **Characters**
tab, and download **one** of these. Any works — pick by look:

| Character | Notes |
| --- | --- |
| **Soldier** | Standard military look. Recommended — reads well at distance. |
| **Swat** | Bulky armour, good team-tint surface area. |
| **James** | Slimmer, more civilian. |

**Download settings — these matter:**

| Setting | Value | Why |
| --- | --- | --- |
| Format | **FBX Binary (.fbx7)** | glTF export is not offered for characters |
| Skin | **With Skin** | This is the character mesh + skeleton |
| Frames per Second | 30 | Matches the animation downloads below |
| Keyframe Reduction | none | Keeps the clip clean |

Then convert it to GLB (see §3) and save it as:

```
public/models/soldier.glb
```

That exact filename is what the game looks for. Nothing else to change.

---

## 2. The animations (11 files)

For **each** of the clips below: search the name in Mixamo's **Animations** tab,
then download with these settings:

| Setting | Value |
| --- | --- |
| Format | **FBX Binary (.fbx7)** |
| Skin | **Without Skin** ← required, as you specified |
| Frames per Second | 30 |
| Keyframe Reduction | none |

### ⚠️ Tick "In Place" for every locomotion clip

This is the single most important setting on this page, and it is easy to miss
because it is a small checkbox next to the download button.

**Tick "In Place" for:**

- `Walking`
- `Walking Backward`
- `Left Strafe Walking`
- `Right Strafe Walking`
- `Running`
- `Crouched Walking`

**Why:** without it, Mixamo bakes the character's forward travel into the
`Hips` bone's position track. The character then *walks away from itself* — the
root drifts forward while the code also moves the character, so bots slide
across the floor, clip through walls, and never line up with their own capsule.
With "In Place" ticked the clip is a pure cycle and the code owns all movement,
which is what a game needs.

The clips that should **not** have it ticked are the one-shots (`Firing Rifle`,
`Reloading`, `Death From Front`) — they have no travel to remove.

### The clip list

| # | Mixamo search term | Game state it drives | In Place? |
| --- | --- | --- | --- |
| 1 | `Idle` | Stand still | — |
| 2 | `Walking` | Walk forward | ✅ **tick** |
| 3 | `Walking Backward` | Walk backwards | ✅ **tick** |
| 4 | `Left Strafe Walking` | Strafe left | ✅ **tick** |
| 5 | `Right Strafe Walking` | Strafe right | ✅ **tick** |
| 6 | `Running` | Sprint | ✅ **tick** |
| 7 | `Crouching Idle` | Crouch, stationary | — |
| 8 | `Crouched Walking` | Crouch, moving | ✅ **tick** |
| 9 | `Firing Rifle` | Fire | — |
| 10 | `Reloading` | Reload | — |
| 11 | `Death From Front` | Death | — |

**Two clips have no good Mixamo equivalent** and need a substitute:

| Needed | Problem | Suggested substitute |
| --- | --- | --- |
| **Hit react** | Mixamo has no dedicated flinch | `Hit Reaction` (search "hit") or reuse `Death From Front` truncated to 0.3 s |
| **Crouch walk** | `Crouched Walking` is a shuffle, not a proper crouch-walk | `Crouched Walking` is still the closest match; alternatively use `Walking` with the hips lowered in code |

If a search term returns nothing, try the alternate spelling Mixamo uses
(`Idle` is sometimes listed as `Idle (1)`; `Walking` as `Walk`).

---

## 3. Converting FBX → GLB

Mixamo only exports FBX, and the game loads GLB.

> ### ⚠️ `gltf-transform` cannot read FBX
>
> `npx @gltf-transform/cli copy soldier.fbx out.glb` **fails** — the CLI only
> reads glTF/GLB/OBJ/PLY/STL. It has no FBX importer at all. Use one of the two
> tools below instead.

### Option A — FBX2glTF (command line)

Download a release from <https://github.com/facebookincubator/FBX2glTF/releases>
(Windows: `FBX2glTF-windows-x64.exe`). Then, from the project root:

```bat
:: The character. Keep the skin and the skeleton.
FBX2glTF-windows-x64.exe -i soldier.fbx -o public\models\soldier.glb -b

:: Each animation, on its own. These have no skin, so they stay small.
FBX2glTF-windows-x64.exe -i Anim_Idle.fbx       -o public\models\anim\Idle.glb -b
FBX2glTF-windows-x64.exe -i Anim_Walking.fbx    -o public\models\anim\Walking.glb -b
FBX2glTF-windows-x64.exe -i Anim_WalkBack.fbx   -o public\models\anim\WalkingBackward.glb -b
FBX2glTF-windows-x64.exe -i Anim_StrafeL.fbx    -o public\models\anim\StrafeLeft.glb -b
FBX2glTF-windows-x64.exe -i Anim_StrafeR.fbx    -o public\models\anim\StrafeRight.glb -b
FBX2glTF-windows-x64.exe -i Anim_Running.fbx    -o public\models\anim\Running.glb -b
FBX2glTF-windows-x64.exe -i Anim_CrouchIdle.fbx -o public\models\anim\CrouchIdle.glb -b
FBX2glTF-windows-x64.exe -i Anim_CrouchWalk.fbx -o public\models\anim\CrouchWalk.glb -b
FBX2glTF-windows-x64.exe -i Anim_Firing.fbx     -o public\models\anim\Firing.glb -b
FBX2glTF-windows-x64.exe -i Anim_Reloading.fbx  -o public\models\anim\Reloading.glb -b
FBX2glTF-windows-x64.exe -i Anim_Death.fbx      -o public\models\anim\Death.glb -b
```

`-b` writes binary GLB rather than JSON glTF. Add `--skins` is **not** needed —
skins are kept by default; only `--no-flip-v` and similar are worth reading
about if the model comes out upside down.

### Option B — Blender (no extra download if you have it)

1. **File → Import → FBX (.fbx)**, pick the file.
2. In the import panel, leave *Automatic Bone Orientation* on.
3. **File → Export → glTF 2.0 (.glb)`**.
4. In the export panel set **Format: glTF Binary (.glb)**, and under *Include*
   tick **Skinning** for the character (leave it off for the animation-only
   files, which have no mesh).
5. Name the output exactly as in the table above.

Blender is the more reliable of the two for Mixamo files — FBX2glTF occasionally
mangles the bone roll on Mixamo skeletons, which shows up as a twisted forearm.

**Expected result:** `soldier.glb` around 2–8 MB, each animation GLB well under
1 MB. A typical Mixamo soldier is 15k–40k triangles, comfortably inside the 50k
budget — unlike the viewmodel, which is 69k.

---

## 4. How the animation GLBs get applied to `soldier.glb`

This is the part that surprises people: **the animation files are separate
models, and they are not merged into the character at load time.**

Each animation FBX — exported "Without Skin" — still contains a full copy of the
Mixamo skeleton, just with no mesh on it. That skeleton has the *same bone names*
as `soldier.glb`, because both came from Mixamo. So the clips are applied by
**name matching at runtime**, not by merging files:

```
soldier.glb  ──>  one SkinnedMesh + skeleton (Hips, Spine, LeftArm, ...)
Idle.glb     ──>  AnimationClip with tracks named "mixamorigHips.position", ...
```

The plan for Phase 4, in `src/characters/animation.ts`:

1. Load `soldier.glb` once with `GLTFLoader`.
2. Load each animation GLB with `GLTFLoader` — **only its `gltf.animations`
   array is used**; the skeleton that comes with it is discarded.
3. Clone the soldier per character with `SkeletonUtils.clone()`.
4. Create **one `AnimationMixer` per character**, constructed from that
   character's cloned root.
5. For each clip, `mixer.clipAction(clip)` and play it. Three.js resolves each
   track by **bone name** against the mixer's root, so a clip from `Idle.glb`
   drives the clone of `soldier.glb` as long as the names match.

Because every character owns its own mixer and its own clone, the 8 bots animate
independently from one set of loaded clips — the clips themselves are shared and
never duplicated.

**Two gotchas this design avoids:**

- **Do not** create one mixer from `soldier.glb`'s root and share it across
  clones. A mixer binds to specific bone *objects*, so all 8 characters would
  play the same pose, in lockstep, like a chorus line.
- **Do not** merge the animation skeletons into the character scene graph. You
  would get 11 extra skeletons per character, and the extra `Hips` bones would
  fight over the same names.

Bone-name matching is also why the code strips Mixamo's namespace prefix
(`mixamorig:`, `mixamorig7:`) when it builds its bone lookup — the prefix
differs between Mixamo export versions, but the names after it do not.

---

## 5. The rifle (one file, optional)

Each character carries a rifle welded to `RightHand`. Until a model is supplied,
a **procedural placeholder** built from boxes is used — about 130 triangles,
correct AK-74U proportions (0.73 m), grip at the origin and barrel down -Z.

The supplied `ak74u__free_animation..glb` is **not** used for this: its rifle is
49,666 triangles, so 8 characters would carry ~400,000 triangles of gun — more
than the whole level. That asset is kept for the first-person ADS viewmodel,
where exactly one instance exists.

### Recommended model

**Quaternius — "Ultimate Guns Pack"** (CC0, public domain, no attribution
required). It contains an AK-47 among ~30 weapons, is low-poly, and is free for
commercial use.

- Pack page: <https://quaternius.com/>
- Direct download: <https://quaternius.com/packs/ultimategunspack.html>
- Mirror with per-model pages: <https://poly.pizza/search/ak%2047> (search
  "Ak47" by Quaternius)

Download the pack, take the AK mesh out of it, convert to GLB if it is not
already, and save it as:

```
public/models/rifle.glb
```

The loader normalises whatever it finds: it rotates the longest axis onto the
barrel, scales the weapon to `RIFLE.length` (0.73 m), and centres it on the
origin. It logs what it did:

```
[rifle] loaded /models/rifle.glb | 1,240 tris, 890 verts | size 0.052 x 0.180 x 0.730 m | muzzle [-0.01, 0.02, -1.00]
```

### Tuning the grip (F4)

A generic model carries no information about where its grip is, and Mixamo hand
bones use their own axis convention, so the final offset is **tuned visually**
rather than derived. Press **F4** in game:

| Key | Action |
| --- | --- |
| Arrows | Move along/across the barrel |
| PageUp / PageDown | Lift / lower |
| I / K | Pitch |
| J / L | Yaw |
| U / O | Roll |
| `-` / `+` | Scale |
| Shift / Ctrl | Fine / coarse steps |
| **P** | Print the values |
| R | Reset to the config values |
| F4 | Close (also prints) |

Movement is locked while the tool is open so the character stands still and the
keys are free. Press **P** and paste the printed block over `RIFLE.grip` in
`src/config.ts`:

```ts
grip: {
  position: { x: 0.0000, y: 0.0000, z: 0.0000 },
  rotation: { x: 0.00, y: 0.00, z: 0.00 },
  scale: 1.0000,
},
```

---

## 6. Check it worked

Reload the game and look at the console. You should see:

```
[soldier] loaded /models/soldier.glb | 24,318 tris | raw height 1.780 m -> scale 1.0112 for 1.8 m | 0 clips: (none)
[character] blue soldier | 3 meshes | bones: 65 | head bone: Head | rifle: attached to RightHand
[rifle] loaded /models/rifle.glb | 1,240 tris, 890 verts | size 0.052 x 0.180 x 0.730 m
```

If instead you see:

```
[soldier] /models/soldier.glb not found — using the procedural blockout rig.
[rifle] built procedural placeholder | 132 tris, 792 verts | size 0.055 x 0.245 x 0.730 m
```

then the files are not in `public/models/` or the conversion failed. The game
still runs — those are fallback notices, not errors.

---

## 7. What the code does with these files

| Step | Where |
| --- | --- |
| Loads and normalises the soldier to 1.8 m, feet at y = 0 | `loadSoldierSource()` |
| Clones it per character with `SkeletonUtils.clone()` | `createSoldierCharacter()` |
| Strips the `mixamorig:` namespace from bone names | `createSoldierCharacter()` |
| Tints each team blue/red | `applyTeamTint()` |
| Attaches the rifle to `RightHand` | `attachRifle()` |
| Loads/normalises the rifle, or builds the placeholder | `loadRifle()` |
| Live grip tuning + config printing | `createGripDebug()` |

Animation clip → game state mapping is Phase 4 work and lives in
`src/characters/animation.ts`, which reads the clip names listed above.

---

## Why the supplied viewmodel could not be retargeted

It is worth recording, because the file *looks* Mixamo-compatible: every bone is
named `mixamorig7:*`. But the bone list is arms and fingers only —

```
Hips       NO
Spine      NO
Legs/feet  NO
Arms       YES (43 bones)
Fingers    YES (30 bones)
```

Mixamo's locomotion clips animate `Hips`, `Spine`, `LeftUpLeg`, `RightUpLeg`,
`LeftFoot`. This skeleton has none of those bones, so there is nothing to drive.
Retargeting is not "hard" here, it is impossible — which is why the viewmodel is
used for its real purpose (first-person ADS) and a soldier is used for the body.
