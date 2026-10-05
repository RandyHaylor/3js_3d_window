# 3js_3d_window — Implementation Plan

Source brief: [`phone_3d_window_demo_plan.txt`](phone_3d_window_demo_plan.txt)

## Goal

One static web page, hosted on GitHub Pages, that turns an iPhone screen into a
window onto a fixed 3D room. The view follows the viewer's eye position
(front camera + MediaPipe Face Landmarker) and the phone's orientation
(DeviceOrientation). Everything runs in the browser, with no backend and no uploads.

## Stack

| Concern        | Choice                                                               |
| -------------- | -------------------------------------------------------------------- |
| Hosting        | GitHub Pages from `main` branch root (HTTPS by default)               |
| Rendering      | Three.js `0.170.0` via import map from jsDelivr                       |
| Face tracking  | `@mediapipe/tasks-vision@0.10.35` Face Landmarker (GPU delegate, CPU fallback) |
| Model          | `face_landmarker.task` float16 from Google's model bucket             |
| Build          | None: plain ES modules, so the repo is deployed as-is               |
| Tests          | `node --test` on the pure math modules (no browser needed)            |

## Files

```
index.html            page, import map, start overlay, HUD, settings panel
style.css             UI styling
src/main.js           app wiring: start flow, render loop, UI, settings persistence
src/scene.js          the fixed room (grid floor/walls, near/mid/far objects, lights)
src/windowMath.js     pure math: off-axis frustum, landmark→eye conversion (tested)
src/filters.js        One Euro filter for eye smoothing (tested)
src/faceTracker.js    MediaPipe wrapper: video in → iris midpoint + interocular px
src/orientation.js    DeviceOrientation → quaternion, reference (Center) handling
test/*.test.mjs       node tests for windowMath and filters
```

## Coordinate model

- Units are **meters**. The rig frame is attached to the phone: the screen sits
  in the z=0 plane centered on the origin, +x right, +y up, and +z points toward the viewer.
- Physical screen size = CSS viewport size ÷ CSS-px-per-inch (default 153 on
  phones, 96 on desktop, adjustable).
- The eye position `E` is expressed in the rig frame. The off-axis frustum through the
  screen rectangle at near distance `n` is:
  `l = (-W/2 - Ex)·n/Ez`, `r = (W/2 - Ex)·n/Ez`, `b = (-H/2 - Ey)·n/Ez`, `t = (H/2 - Ey)·n/Ez`.
  The camera sits at `E` with the rig's rotation, so it always looks along the
  screen normal.
- Phone orientation rotates the rig in world space:
  `rig = inverse(qCenter) · qNow`. Tapping **Center** stores `qCenter`, so the
  room appears straight ahead in whatever pose the phone is held.

## Eye estimation

1. Face Landmarker returns 478 normalized landmarks. Iris centers are 468 and 473.
2. Interocular distance in pixels uses x, y and the landmark z (z is scaled like x),
   which partly compensates for head yaw.
3. Pinhole model: `f = (longSide/2) / tan(FOV_long/2)`; `Z = f·IPD/ipdPx`;
   `X = -(u - cx)·Z/f` (front camera is not mirrored); `Y = -(v - cy)·Z/f`.
4. Camera → screen-center offset: the camera sits above the display top, so
   `eye.y += H/2 + cameraOffsetMm`.
5. Defaults: IPD 63 mm, FOV 70° on the long axis, camera offset 5 mm. All are
   adjustable in the settings panel, alongside an overall depth scale.

## Smoothing and tracking loss

- A One Euro filter runs per axis (separate tuning for z, which is noisier).
- Lost face for more than 250 ms: show a "Face lost" pill and hold the last eye position.
  After 2 s the eye eases slowly toward a neutral default.
- On reacquire the filters reset and the displayed eye blends to the new
  estimate over ~0.4 s, so the view never jumps.

## User flow

1. Open the URL → **Start** (or **Simulate**, which needs no camera and uses pointer/touch to drive the eye).
2. Inside the Start tap handler, request `DeviceOrientationEvent.requestPermission()`
   (iOS) and `getUserMedia({facingMode:'user'})` synchronously, before any await.
3. Load the model, then begin tracking. Tap **Center** to set the orientation reference
   (the button becomes **Recenter**).
4. Settings drawer: CSS px/inch, IPD, camera FOV, camera offset, depth scale,
   world scale, smoothing, flip X, orientation on/off, camera preview, debug readout.
   Settings persist in `localStorage` (wrapped in try/catch).

## Build sequence (mirrors the brief)

1. **Scene + projection**: room, off-axis camera, Simulate mode driven by pointer.
   Unit-test the frustum math.
2. **Face tracking**: MediaPipe wiring, landmark→eye conversion (unit-tested), filters.
3. **Orientation + recenter + loss handling.**
4. **Publish**: push to `main`, enable Pages, test on iPhone Safari.

## Verification

- `node --test` covers frustum symmetry and asymmetry, eye conversion (distance from IPD,
  lateral sign), and filter convergence.
- Local headless browser load in Simulate mode to confirm no console errors and
  that the render changes when the simulated eye moves.
- On-device checklist (manual, iPhone Safari):
  - permissions prompts appear
  - parallax direction is correct (move right → see more of the room's left side)
  - distance readout roughly matches a ruler
  - rotation turns the view
  - covering the camera shows "Face lost" with no jump
  - frame rate stays smooth

## Out of scope (from the brief)

Gaze direction, phone translation in world space, and landscape-specific camera offsets
(portrait is the target).
