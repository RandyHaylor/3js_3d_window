import * as THREE from 'three';
import { createScene } from './scene.js';
import {
  displaySizeM,
  pageSizeM,
  eyeFromIris,
  knownFrontCameraFov,
  fovForMeasuredDistance,
  screenModelKey,
  irisDiameterPx,
  matrixTranslation,
  IRIS_DIAMETER_M,
  approach,
} from './windowMath.js';
import {
  MotionScaleEstimator,
  MIN_SCALE_PAIRS,
  fitEyeCorrection,
  rawDistanceElasticity,
  angularSizeLimit,
} from './calibration.js';
import {
  rotate,
  qmul,
  screenPoseFromCamera,
  relativePose,
  windowCamera,
  eyeInWorld,
  levelUp,
} from './viewModel.js';
import { Vec3Filter, OutlierGate } from './filters.js';
import { FaceTracker, openFrontCamera, availableCameraSizes } from './faceTracker.js';
import { PhoneTracker } from './phoneTracker.js';
import { FrameSource } from './frameSource.js';
import { OrientationTracker, requestOrientationPermission, eventTime } from './orientation.js';
import { DelayEstimator } from './timeline.js';

const FAR = 6;
const LOST_AFTER = 0.25; // s without a face before the view is blanked

const IS_PHONE = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;

// ---------- settings ----------

const DEFAULTS = {
  ipdMm: 63,
  fovDeg: knownFrontCameraFov(screen.width, screen.height, devicePixelRatio) ?? 70,
  camGapMm: 0, // fine adjustment of the front camera's position, from the display's top edge
  worldScale: 1,
  smoothing: 4,
  rotationSmoothing: 4, // Hz, camera rotation (eye → phone direction)
  flipX: false,
  useIris: true, // iris diameter (11.7 mm) is the physical reference for eye scale
  autoEyeCal: false, // automatic eye-correction fit (assumes a still head; off until verified)
  useOrientation: true,
  showPreview: false,
  phoneTracking: true,
  showStats: false, // stats drawer (top-left ▾)
  cameraSize: '640x480', // requested front-camera size; larger only if a camera crops at small sizes
  // Automatic eye-position corrections (see calibration.js), kept between visits.
  eyeLateral: 1,
  eyeDepth: 1,
  eyeDepthOffset: 0, // meters
  eyeOffsetManual: false, // set when the user adjusts the offset; stops the auto fit changing it
};

const SLIDERS = [
  {
    key: 'eyeDepthOffset',
    label: 'Distance offset',
    unit: 'm',
    min: -1,
    max: 3,
    step: 0.01,
    hint: 'Added to the measured eye distance. Raise it if leaning in changes the view too much.',
  },
  { key: 'worldScale', label: 'World scale', unit: '×', min: 0.1, max: 2, step: 0.01, hint: 'Size of the virtual objects; 1 m stays 1 m.' },
  { key: 'ipdMm', label: 'Eye spacing (IPD)', unit: 'mm', min: 50, max: 76, step: 0.5 },
  { key: 'fovDeg', label: 'Camera FOV (long side)', unit: '°', min: 40, max: 100, step: 0.5, hint: 'Check the distance readout against a ruler.' },
  {
    key: 'camGapMm',
    label: 'Camera offset from display top',
    unit: 'mm',
    min: -20,
    max: 20,
    step: 0.5,
    hint: 'The front camera sits half the display height above its center; this fine-tunes that.',
  },
  { key: 'smoothing', label: 'Smoothing cutoff', unit: 'Hz', min: 0.2, max: 30, step: 0.1, hint: 'Lower = steadier, higher = snappier.' },
  {
    key: 'rotationSmoothing',
    label: 'Camera rotation smoothing',
    unit: 'Hz',
    min: 0.2,
    max: 30,
    step: 0.1,
    hint: 'Smooths the eye → phone direction. Lower = steadier, higher = snappier.',
  },
];
const TOGGLES = [
  { key: 'flipX', label: 'Flip left/right' },
  { key: 'useIris', label: 'Use iris size for distance (instead of eye spacing)' },
  { key: 'useOrientation', label: 'Use phone orientation' },
  { key: 'showPreview', label: 'Show camera preview' },
  { key: 'phoneTracking', label: 'Phone tracking (AlvaAR room tracking)' },
  { key: 'autoEyeCal', label: 'Automatic eye correction (experimental; assumes a still head)' },];

// v2: new defaults (iris scale, no automatic eye correction); v1 values are not carried over.
const STORAGE_KEY = '3d-window-settings-v2';
const settings = { ...DEFAULTS, ...loadSettings() };

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}
function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: settings last for this visit only */
  }
}

// ---------- DOM ----------

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const video = $('cam');
const intro = $('intro');
const hud = $('hud');
const statusEl = $('status');
const debugEl = $('debug');
const errorEl = $('error');
const centerBtn = $('center');
const settingsPanel = $('settings');

// ---------- rendering ----------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const { scene, setWorldScale } = createScene();
const camera = new THREE.PerspectiveCamera();
camera.matrixAutoUpdate = true;

// Real-world sizes (meters). The display's physical size comes from the iPhone table, or
// the fallback height (2.5 in mobile, 8 in desktop). The visible page we render into is the
// fraction of the display it covers. Screen values are only ever used as ratios.
let displayM = { w: 0.07, h: 0.15, known: false };
let screenM = { w: 0.07, h: 0.15 }; // the visible page = the window
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  // Orient the screen's values like the page (iOS reports screen size in portrait).
  const landscape = innerWidth > innerHeight;
  const sw = landscape ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const sh = landscape ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
  displayM = displaySizeM(sw, sh, devicePixelRatio, IS_PHONE);
  screenM = pageSizeM(displayM, innerWidth, innerHeight, sw, sh);
}
addEventListener('resize', resize);
resize();

// ---------- state ----------

let mode = 'idle'; // idle | camera | sim
let tracker = null;
const frames = new FrameSource(video); // camera frame, downscaled once per frame
let cameraCaps = null; // the front camera's reported capabilities (sizes it can deliver)
const camRate = { fps: 0, lastT: null }; // camera frames processed per second
const orient = new OrientationTracker();
let orientState = 'off';

// The eye in the SCREEN frame (meters): what face tracking measures.
const neutralEye = () => ({ x: 0, y: 0, z: IS_PHONE ? 0.33 : 0.6 });
const eye = neutralEye();
const simEye = neutralEye();

// The eye in the WORLD frame. It changes only when face tracking measures the eye; while
// the eyes aren't visible it stays where it was last seen.
let eyeAnchor = null;
const phoneQ = new THREE.Quaternion();
const view = { phoneW: [0, 0, 0], d: 0, source: '' }; // for the debug readout

const filter = new Vec3Filter();
// Smooths the eye's WORLD position (eyeAnchor). Smoothing after the phone rotation is
// applied keeps a still head still while the phone turns. World z is roughly the viewing
// depth (the viewer faces the phone at Recenter), so it gets the depth settings.
const worldEyeFilter = new Vec3Filter();
// Drops single bad eye measurements (in the world) before they reach eyeAnchor.
const eyeGate = new OutlierGate();
// Smooths the camera's direction (unit eye → phone vector), setting rotationSmoothing.
const dirFilter = new Vec3Filter();
function applySmoothing() {
  const xy = { minCutoff: settings.smoothing, beta: 8 };
  const z = { minCutoff: settings.smoothing * 0.6, beta: 4 };
  filter.setParams(xy, z);
  worldEyeFilter.setParams(xy, z);
  dirFilter.setParams({ minCutoff: settings.rotationSmoothing, beta: 2 });
}
applySmoothing();

const track = { lastSeen: -Infinity, lost: true, ipdPx: 0 };

// Running mean and jitter (std dev) of a raw signal, for comparing distance sources.
class Jitter {
  mean = 0;
  vari = 0;
  n = 0;
  add(v) {
    const a = this.n++ < 10 ? 1 / this.n : 0.1;
    const d = v - this.mean;
    this.mean += a * d;
    this.vari += a * (d * d * (1 - a) - this.vari);
  }
  text() {
    return this.n ? `${(this.mean * 100).toFixed(1)}±${(Math.sqrt(this.vari) * 100).toFixed(1)}` : '–';
  }
}
const distStats = { eyes: new Jitter(), eyes2d: new Jitter(), iris: new Jitter(), face: new Jitter() };

// ---------- automatic calibration (calibration.js) ----------

// Meters per AlvaAR unit, from AlvaAR's motion vs. the accelerometer.
const motionScale = new MotionScaleEstimator();

// How long before a camera frame's reported time it was really captured (timeline.js).
const cameraDelay = new DelayEstimator();
let cameraDelayT = 0;
// ---------- debug log (Send log in the stats drawer) ----------
// The last LOG_SECONDS of raw inputs, so problems on the device can be analyzed exactly.
const LOG_SECONDS = 20;
const debugLog = { imu: [], frames: [] };
function trimLog(list, t) {
  while (list.length && list[0].t < t - LOG_SECONDS) list.shift();
}
function logImu(t, a) {
  debugLog.imu.push({ t: +t.toFixed(4), a: a.map((v) => +v.toFixed(4)) });
  trimLog(debugLog.imu, t);
}

// The phone counts as moving only while the accelerometer says so. The camera position
// (the phone position) may only change then.
const phoneMotion = { acc: 0, lastMovingT: -Infinity, hasData: false };
const MOVING_ACCEL = 0.2; // m/s², smoothed magnitude
const MOVING_HOLD = 0.3; // s
const phoneIsMoving = () => performance.now() / 1000 - phoneMotion.lastMovingT < MOVING_HOLD;
addEventListener('devicemotion', (e) => {
  const a = e.acceleration; // without gravity, m/s²
  if (!a || a.x === null) return;
  const t = eventTime(e); // when it was measured
  phoneMotion.hasData = true;
  motionScale.addImu([a.x, a.y, a.z], t);
  logImu(t, [a.x, a.y, a.z]);
  phoneMotion.acc += (Math.hypot(a.x, a.y, a.z) - phoneMotion.acc) * 0.3;
  if (phoneMotion.acc > MOVING_ACCEL) phoneMotion.lastMovingT = t;
});

// Face-tracked eye before the automatic correction (screen frame, meters).
const eyeRaw = neutralEye();
// Physical display height (meters): the full screen in portrait, from its CSS size and the
// model's px per inch. The visible page can be shorter (Safari's bars); the front camera
// sits relative to the display, not the page.
const displayHeightM = () => displayM.h;
// Front camera position relative to the display center: half the display height up.
const camInScreen = () => [0, displayHeightM() / 2 + settings.camGapMm / 1000, 0];

// Apply the eye correction: lateral offsets are rescaled, and distance from the camera
// follows the depth model true = b·raw + δ. Scales come from the automatic fit only when
// it is enabled; the distance offset δ is always applied (manual slider or fit).
function correctEye(raw) {
  const c = camInScreen();
  const lateral = settings.autoEyeCal ? settings.eyeLateral : 1;
  const depth = settings.autoEyeCal ? settings.eyeDepth : 1;
  return {
    x: c[0] + (raw.x - c[0]) * lateral,
    y: c[1] + (raw.y - c[1]) * lateral,
    z: c[2] + (raw.z - c[2]) * depth + settings.eyeDepthOffset,
  };
}

// Largest rotation (radians) between the first sample and any other.
function rotationSpread(samples) {
  const q0 = samples[0].q;
  let max = 0;
  for (const { q } of samples) {
    const d = Math.abs(q0.x * q.x + q0.y * q.y + q0.z * q.z + q0.w * q.w);
    max = Math.max(max, 2 * Math.acos(Math.min(1, d)));
  }
  return max;
}

const eyeFit = { samples: [], lastT: 0, last: null };
const EYE_FIT_WINDOW = 90; // samples (~3 s)

// Collect samples while the phone pose is measured; refit the eye correction every half
// second when the phone has moved enough to constrain it.
function updateEyeCorrection(measured, t) {
  const c = camInScreen();
  const s = eyeFit.samples;
  s.push({ p: measured.p, q: measured.q, u: [eyeRaw.x - c[0], eyeRaw.y - c[1], eyeRaw.z - c[2]], c });
  if (s.length > EYE_FIT_WINDOW) s.shift();
  if (t - eyeFit.lastT < 0.5 || s.length < EYE_FIT_WINDOW / 2) return;
  eyeFit.lastT = t;

  const spread = [0, 1, 2].map((i) => Math.max(...s.map((x) => x.p[i])) - Math.min(...s.map((x) => x.p[i])));
  if (Math.max(...spread) < 0.04) return; // phone hasn't moved enough
  // The depth offset is only separable from the eye's position when the phone also tilts.
  const withOffset = !settings.eyeOffsetManual && rotationSpread(s) > (6 * Math.PI) / 180;
  // Without enough tilt, keep the current offset fixed by folding it into the camera position.
  const fitSamples = withOffset
    ? s
    : s.map((x) => ({ ...x, c: [x.c[0], x.c[1], x.c[2] + settings.eyeDepthOffset] }));
  const fit = fitEyeCorrection(fitSamples, withOffset);
  eyeFit.last = fit;
  // Reject fits that don't explain the motion (e.g. the head moved too).
  if (!fit || fit.rms > 0.015 || fit.lateral < 0.6 || fit.lateral > 1.6 || fit.depth < 0.6 || fit.depth > 1.6) return;
  if (Math.abs(fit.offset) > 0.15) return;
  settings.eyeLateral += (fit.lateral - settings.eyeLateral) * 0.2;
  settings.eyeDepth += (fit.depth - settings.eyeDepth) * 0.2;
  if (withOffset) settings.eyeDepthOffset += (fit.offset - settings.eyeDepthOffset) * 0.2;
  saveSettings();
}

function resetCalibration() {
  motionScale.reset();
  eyeFit.samples.length = 0;
}

const calibration = () => ({
  ipdM: settings.ipdMm / 1000,
  fovLongDeg: settings.fovDeg,
  camOffsetM: settings.camGapMm / 1000,
  flipX: settings.flipX,
});

function moveToward(p, target, k) {
  p.x += (target.x - p.x) * k;
  p.y += (target.y - p.y) * k;
  p.z += (target.z - p.z) * k;
}

// Phone tracking: AlvaAR on the front camera measures the phone's pose in the room.
let phoneTracker = null;
let seenResets = 0;

function startPhoneTracker() {
  if (phoneTracker || mode !== 'camera' || !tracker || !settings.phoneTracking) return;
  const pt = new PhoneTracker(frames);
  phoneTracker = pt;
  pt.canvas.className = 'alva-preview';
  hud.appendChild(pt.canvas);
  pt.init(settings.fovDeg).catch((err) => {
    console.error(err);
    pt.status = `failed: ${err.message || err}`;
  });
}

function stopPhoneTracker() {
  if (!phoneTracker) return;
  phoneTracker.canvas.remove();
  phoneTracker = null;
}

// Face tracking → eye in the screen frame.
function updateTracking(t, nowMs) {
  // One downscale per new camera frame, shared by face and phone tracking.
  const fresh = tracker ? frames.grab() : false;
  if (fresh) {
    if (camRate.lastT !== null) camRate.fps += (1 / Math.max(1e-3, t - camRate.lastT) - camRate.fps) * 0.1;
    camRate.lastT = t;
  }
  const r = fresh ? tracker.detect(nowMs) : undefined;
  // One pass per camera frame, everything at this frame's capture time (tc, on the motion
  // sensors' clock): AlvaAR's phone position from this frame, the face tracker's eye from
  // this frame, and the phone rotation interpolated to the same moment.
  const tc = fresh ? frames.frameT - (cameraDelay.delay ?? 0) : t;
  // A new video frame arrived (r is null when it has no face).
  if (r !== undefined && phoneTracker) {
    const pt = phoneTracker;
    pt.update();
    if (pt.resets !== seenResets) {
      seenResets = pt.resets; // new map: new origin and new scale
      resetCalibration();
    }
    if (pt.status === 'tracking' && pt.position) motionScale.addPosition(pt.position, tc);
  }
  if (fresh) updatePhonePosition(tc);
  if (fresh) {
    const pt = phoneTracker;
    debugLog.frames.push({
      t: +t.toFixed(4),
      eyes: r ? 1 : 0,
      eye: r ? [eyeRaw.x, eyeRaw.y, eyeRaw.z].map((v) => +v.toFixed(4)) : null,
      alva: pt ? pt.status : null,
      alvaPos: pt && pt.position ? pt.position.map((v) => +v.toFixed(4)) : null,
      pts: pt ? pt.points : 0,
      alvaMs: pt ? +pt.ms.toFixed(1) : 0,
      pairs: motionScale.pairs,
      scale: motionScale.scale,
      moving: phoneIsMoving() ? 1 : 0,
      phonePos: phonePos.map((v) => +v.toFixed(4)),
    });
    trimLog(debugLog.frames, t);
  }
  if (r) {
    const cal = calibration();
    const iris = { px: irisDiameterPx(r.irises, r.videoW, r.videoH), m: IRIS_DIAMETER_M };
    const dispH = displayHeightM(); // the camera sits half of this above the display center
    const byEyes = eyeFromIris(r.a, r.b, r.videoW, r.videoH, cal, dispH);
    const byIris = eyeFromIris(r.a, r.b, r.videoW, r.videoH, cal, dispH, iris);
    if (byEyes) distStats.eyes.add(byEyes.z);
    // Diagnostic: eye spacing from the 2D landmark positions only (no MediaPipe depth term).
    const by2d = eyeFromIris({ ...r.a, z: 0 }, { ...r.b, z: 0 }, r.videoW, r.videoH, cal, dispH);
    if (by2d) distStats.eyes2d.add(by2d.z);
    if (byIris) distStats.iris.add(byIris.z);
    if (r.faceMatrix) distStats.face.add(Math.abs(matrixTranslation(r.faceMatrix)[2]) / 100);

    const e = settings.useIris ? byIris : byEyes;
    if (e) {
      if (track.lost) {
        filter.reset();
        worldEyeFilter.reset();
        eyeGate.reset();
        track.lost = false;
      }
      track.lastSeen = t;
      track.ipdPx = e.ipdPx;
      Object.assign(eyeRaw, filter.filter(e, tc));
      Object.assign(eye, correctEye(eyeRaw));
      // The eye's world position: this measurement (unsmoothed) placed by the phone's
      // position and rotation at this frame's capture time, then smoothed in the world.
      const m = correctEye(e);
      const wp = eyeInWorld(phonePos, phoneRotationAt(tc), [m.x, m.y, m.z]);
      const measuredW = { x: wp[0], y: wp[1], z: wp[2] };
      if (eyeGate.accept(measuredW, tc)) {
        const w = worldEyeFilter.filter(measuredW, tc);
        eyeAnchor = [w.x, w.y, w.z];
      }
      // Camera delay: eye directions stamped with the frame's reported time (no delay
      // applied), compared against the rotation history.
      cameraDelay.add(frames.frameT, [m.x, m.y, m.z]);
      if (t - cameraDelayT > 0.5) {
        cameraDelayT = t;
        cameraDelay.update(phoneRotationAt);
      }
    }
  }
  if (t - track.lastSeen > LOST_AFTER) track.lost = true;

  // One status line per part, so nothing hides anything else:
  //   Eyes  = face tracking sees the eyes
  //   Room  = AlvaAR has locked onto the room
  //   Scale = AlvaAR units → meters, learned from moving the phone (n of required samples)
  const pt = phoneTracker;
  if (!tracker) {
    setStatus('Loading face model…');
  } else {
    const eyes = track.lost ? 'Eyes ✗' : 'Eyes ✓';
    const room = !pt ? '' : pt.status === 'tracking' ? ' · Room ✓' : ' · Room …';
    const scale = !pt
      ? ''
      : motionScale.scale !== null
        ? ' · Scale ✓'
        : ` · Scale ${Math.min(motionScale.pairs, MIN_SCALE_PAIRS)}/${MIN_SCALE_PAIRS}`;
    const ready = !track.lost && (!pt || (pt.status === 'tracking' && motionScale.scale !== null));
    setStatus(eyes + room + scale, ready ? 'ok' : track.lost ? 'warn' : '');
  }
}

// Phone pose measured by AlvaAR (front camera), as a Three.js-style camera pose using
// the same conversion as AlvaAR's own Three.js connector.
const alvaM = new THREE.Matrix4();
const alvaQ = new THREE.Quaternion();
let alvaRef = null; // raw camera pose at Recenter; the screen pose there becomes the origin
let alvaRefQ = null; // the phone's rotation (motion sensors) at that moment
let alvaResets = 0;

function alvaCameraPose(pose) {
  alvaM.fromArray(pose);
  alvaQ.setFromRotationMatrix(alvaM);
  return { q: { x: -alvaQ.x, y: alvaQ.y, z: alvaQ.z, w: alvaQ.w }, t: [pose[12], -pose[13], -pose[14]] };
}

// Screen pose in our world (meters) from AlvaAR, or null. AlvaAR's motion is measured
// from its reference pose and turned into the world by the phone's rotation at that
// reference moment, so a new AlvaAR map doesn't change the world's axes.
function measuredPhonePose(tc) {
  const pt = phoneTracker;
  const k = motionScale.scale; // meters per AlvaAR unit; null until calibrated
  if (!pt || pt.status !== 'tracking' || !pt.pose || k === null) return null;
  if (pt.resets !== alvaResets) {
    alvaResets = pt.resets; // new map: new origin and scale
    alvaRef = null;
  }
  const cam = alvaCameraPose(pt.pose);
  if (!alvaRef) {
    alvaRef = cam;
    alvaRefQ = phoneRotationAt(tc); // the rotation when this frame was captured
  }
  const ref = screenPoseFromCamera(alvaRef.q, alvaRef.t, k, camInScreen());
  const now = screenPoseFromCamera(cam.q, cam.t, k, camInScreen());
  const rel = relativePose(ref, now);
  return { q: qmul(alvaRefQ, rel.q), p: rotate(alvaRefQ, rel.p) };
}

// The phone's position in the world. This is the camera position. It starts at the origin
// (on Start/Recenter) and changes ONLY while the phone itself is physically moving.
let phonePos = [0, 0, 0];
let lastTrackedP = null; // AlvaAR's previous phone position, to take frame-to-frame deltas

// The phone's rotation since Recenter (identity without motion sensors, e.g. a computer
// screen). Used ONLY to place eye measurements in the world, never for the camera.
function phoneRotation() {
  if (settings.useOrientation && orient.hasData) orient.relative(phoneQ);
  else phoneQ.identity();
  return { x: phoneQ.x, y: phoneQ.y, z: phoneQ.z, w: phoneQ.w };
}

// The same at time t (seconds), interpolated from the timestamped orientation history.
function phoneRotationAt(t) {
  if (settings.useOrientation && orient.hasData) orient.relativeAt(t, phoneQ);
  else phoneQ.identity();
  return { x: phoneQ.x, y: phoneQ.y, z: phoneQ.z, w: phoneQ.w };
}

// Phone position from AlvaAR's pose for the camera frame captured at tc. AlvaAR's motion
// is applied only while the accelerometer shows the phone itself moving. While AlvaAR
// isn't sending, the position holds. Without motion sensors it never changes.
function updatePhonePosition(tc) {
  const sensors = settings.useOrientation && orient.hasData;
  const measured = sensors && phoneMotion.hasData ? measuredPhonePose(tc) : null;
  const moving = phoneIsMoving();
  if (measured) {
    if (lastTrackedP && moving) {
      for (let i = 0; i < 3; i++) phonePos[i] += measured.p[i] - lastTrackedP[i];
    }
    lastTrackedP = measured.p;
    view.measuredQ = measured.q;
    if (!track.lost && settings.autoEyeCal) updateEyeCorrection(measured, tc);
  } else {
    lastTrackedP = null;
  }
  view.source = !sensors
    ? 'no motion sensors: phone fixed'
    : !moving
      ? 'phone at rest'
      : measured
        ? 'moving: AlvaAR'
        : phoneTracker && phoneTracker.status === 'tracking' && motionScale.scale === null
          ? 'moving: scale not calibrated, holding'
          : 'moving: room not tracked, holding';
}

// The camera:
//   position = phone position in space
//   rotation = the eye → phone vector (eyeAnchor → phone), roll level with world up
//   FOV      = from the eye → phone distance and the display's height
// The phone's rotation is not used here. It only places eye measurements in the world
// (updateTracking), so it never turns the camera by itself.
function updateCamera(t) {
  // Simulated eye: a new "measurement" every frame.
  if (mode === 'sim') eyeAnchor = eyeInWorld(phonePos, phoneRotation(), [eye.x, eye.y, eye.z]);
  if (!eyeAnchor) return false;

  const wc = windowCamera(eyeAnchor, phonePos, screenM.w, screenM.h);
  if (!(wc.dist > 0.02)) return false;
  // Camera rotation: the eye → phone direction, smoothed (rotationSmoothing), roll level.
  const ds = dirFilter.filter({ x: wc.dir[0], y: wc.dir[1], z: wc.dir[2] }, t);
  const dl = Math.hypot(ds.x, ds.y, ds.z);
  const dir = [ds.x / dl, ds.y / dl, ds.z / dl];
  camera.position.fromArray(phonePos);
  camera.up.fromArray(levelUp(dir));
  camera.lookAt(phonePos[0] + dir[0], phonePos[1] + dir[1], phonePos[2] + dir[2]);
  camera.fov = wc.fovDeg;
  camera.aspect = wc.aspect;
  camera.near = 0.01;
  camera.far = FAR;
  camera.updateProjectionMatrix();

  view.phoneW = phonePos;
  view.d = wc.dist;
  if (mode === 'sim') view.source = orient.hasData && settings.useOrientation ? 'simulated eye' : 'no motion sensors: phone fixed';
  return true;
}

function recenter() {
  orient.center();
  if (settings.useOrientation) orient.relative(phoneQ);
  else phoneQ.identity();
  phonePos = [0, 0, 0]; // phone (camera) back at the world origin
  lastTrackedP = null;
  alvaRef = null; // AlvaAR: the current pose becomes the reference
  // The world is now the phone's current pose, so the eye is where the phone sees it.
  if (eyeAnchor) eyeAnchor = [eye.x, eye.y, eye.z];
  worldEyeFilter.reset();
  eyeGate.reset();
  dirFilter.reset();
}

// ---------- loop ----------

let lastT = performance.now() / 1000;
let fps = 0;
let lastDebug = 0;

renderer.setAnimationLoop((nowMs) => {
  const t = nowMs / 1000;
  const dt = Math.min(0.1, Math.max(1e-3, t - lastT));
  lastT = t;
  fps += (1 / dt - fps) * 0.05;

  if (mode === 'camera') updateTracking(t, nowMs);
  else if (mode === 'sim') moveToward(eye, simEye, approach(dt, 0.05));

  // Until the eye has been seen once there is nothing meaningful to show. After that, a
  // lost eye stays where it was last seen.
  const hasEye = mode !== 'camera' || (tracker && eyeAnchor !== null);
  setWorldScale(settings.worldScale);
  if (hasEye && updateCamera(t)) renderer.render(scene, camera);
  else renderer.clear();

  if (mode !== 'idle' && t - lastDebug > 0.25) {
    lastDebug = t;
    renderDebug();
  }
});

// ---------- UI ----------

function setStatus(text, kind = '') {
  if (statusEl.textContent !== text) statusEl.textContent = text;
  statusEl.className = 'pill' + (kind ? ' ' + kind : '');
}

// Guideposts for the angular-size invariant: content D behind the screen must not shrink
// in angular size as the viewer leans in, i.e. d ln ẑ / d ln z ≤ 1 + ẑ/D. Uses the fitted
// depth model true = b·raw + δ to show how the RAW estimate behaves; the corrected
// estimate tracks true distance (elasticity 1) once the model is right.
function guidepostLines() {
  const b = settings.eyeDepth;
  const d = settings.eyeDepthOffset;
  const sign = d >= 0 ? '+' : '−';
  const lines = [`depth model true = ${b.toFixed(2)}×raw ${sign} ${Math.abs(d * 100).toFixed(1)} cm`];
  const D = 1; // reference content 1 m behind the screen
  for (const z of [0.2, 0.4]) {
    const raw = (z - d) / b;
    const e = rawDistanceElasticity(z, d);
    const lim = angularSizeLimit(raw, D);
    const ok = e <= lim ? 'OK' : 'VIOLATES';
    lines.push(`guidepost @${z * 100}cm  raw elasticity ${e.toFixed(2)}  limit ${lim.toFixed(2)} (D=1m)  ${ok}`);
  }
  return lines;
}

const debugToggle = $('debugToggle');
function setStatsOpen(open) {
  settings.showStats = open;
  debugEl.hidden = !open;
  $('sendLog').hidden = !open;
  debugToggle.setAttribute('aria-expanded', String(open));
  debugToggle.setAttribute('aria-label', open ? 'Hide stats' : 'Show stats');
}
debugToggle.addEventListener('click', () => {
  setStatsOpen(!settings.showStats);
  if (settings.showStats) renderDebug();
  saveSettings();
});
setStatsOpen(settings.showStats);

// Send the last LOG_SECONDS of raw inputs to the dev server (POST ./log; only the local /
// tunnel server accepts it, GitHub Pages does not).
$('sendLog').addEventListener('click', async () => {
  const btn = $('sendLog');
  const body = {
    sentAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    screen: [screen.width, screen.height, devicePixelRatio],
    page: [innerWidth, innerHeight],
    displayM,
    pageM: screenM,
    camera: [video.videoWidth, video.videoHeight],
    processed: [frames.width, frames.height],
    camFps: camRate.fps,
    orientState,
    motionData: phoneMotion.hasData,
    calibration: { pairs: motionScale.pairs, scale: motionScale.scale, diag: motionScale.diag, lastWindow: motionScale.lastWindow },
    settings,
    frames: debugLog.frames,
    imu: debugLog.imu,
  };
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('./log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    btn.textContent = res.ok ? 'Log sent ✓' : `Send failed (${res.status})`;
  } catch (err) {
    btn.textContent = 'Send failed';
  }
  setTimeout(() => (btn.textContent = 'Send log'), 3000);
});

const euler = new THREE.Euler();
function renderDebug() {
  if (debugEl.hidden) return;
  const cm = (v) => (v * 100).toFixed(1).padStart(6);
  const deg = (r) => ((r * 180) / Math.PI).toFixed(0).padStart(4);
  const offAxis = Math.atan2(Math.hypot(eye.x, eye.y), eye.z);
  euler.setFromQuaternion(phoneQ, 'YXZ');
  const pw = view.phoneW;
  const lines = [
    `eye→screen  x${cm(eye.x)} y${cm(eye.y)} z${cm(eye.z)} cm  ${deg(offAxis)}° off-axis`,
    `phone rot   yaw${deg(euler.y)} pitch${deg(euler.x)} roll${deg(euler.z)}°  (${orientState})`,
    `phone pos   x${cm(pw[0])} y${cm(pw[1])} z${cm(pw[2])} cm  [${view.source}]`,
    `page ${(screenM.w * 100).toFixed(1)}×${(screenM.h * 100).toFixed(1)} cm of display ${(displayM.w * 100).toFixed(1)}×${(displayM.h * 100).toFixed(1)} cm (${displayM.known ? 'iPhone table' : 'fallback'})  ${fps.toFixed(0)} fps`,
    `display ${(displayHeightM() * 100).toFixed(1)} cm tall  front camera ${(camInScreen()[1] * 100).toFixed(1)} cm above center`,
  ];
  if (mode === 'camera') {
    const d = distStats;
    lines.push(`dist cm  eyes ${d.eyes.text()}  2D ${d.eyes2d.text()}  iris ${d.iris.text()}  face ${d.face.text()}`);
    lines.push(`face: ${tracker ? tracker.delegate : 'loading'}  using ${settings.useIris ? 'iris' : 'eyes'}`);
    lines.push(
      `camera: ${video.videoWidth}×${video.videoHeight} → processed ${frames.width}×${frames.height} at ${camRate.fps.toFixed(1)} fps  FOV setting ${settings.fovDeg}°`
    );
    // Input alignment: where each frame's time comes from, and the measured camera delay
    // (needs some phone rotation with the head still to measure).
    const delay = cameraDelay.delay;
    lines.push(
      `timing: frame time from ${frames.timeSource}, camera delay ${delay === null ? 'measuring (turn the phone a little)' : `${(delay * 1000).toFixed(0)} ms`}`
    );
    if (phoneTracker && view.measuredQ) {
      // Rotation since Recenter from AlvaAR vs. the motion sensors: should agree.
      const mq = view.measuredQ;
      euler.setFromQuaternion(new THREE.Quaternion(mq.x, mq.y, mq.z, mq.w), 'YXZ');
      lines.push(`alva rot    yaw${deg(euler.y)} pitch${deg(euler.x)} roll${deg(euler.z)}°  (vs phone rot)`);
    }
    if (phoneTracker) {
      const pt = phoneTracker;
      const pos = pt.position ? pt.position.map((v) => v.toFixed(2).padStart(6)).join(' ') : '–';
      lines.push(`phone track ${pt.status}  pts ${pt.points}  ${pt.ms.toFixed(0)} ms`);
      lines.push(`phone track pos ${pos} (AlvaAR units)`);
      const k = motionScale.scale;
      lines.push(`motion scale ${k === null ? 'calibrating' : k.toFixed(3) + ' m/unit'}  (${motionScale.pairs} samples)`);
      const f = eyeFit.last;
      const fitText = f
        ? `last fit ${f.lateral.toFixed(2)}/${f.depth.toFixed(2)}/${(f.offset * 100).toFixed(1)}cm rms ${(f.rms * 100).toFixed(1)} cm`
        : 'no fit yet';
      lines.push(
        settings.autoEyeCal
          ? `eye corr    lateral ${settings.eyeLateral.toFixed(2)} depth ${settings.eyeDepth.toFixed(2)}  ${fitText}`
          : `eye corr    auto off: lateral 1, depth 1, offset ${(settings.eyeDepthOffset * 100).toFixed(1)} cm`
      );
      lines.push(...guidepostLines());
    }
  }
  debugEl.textContent = lines.join('\n');
}

function showHud() {
  intro.hidden = true;
  hud.hidden = false;
}

function showError(msg) {
  mode = 'idle';
  hud.hidden = true;
  intro.hidden = false;
  errorEl.hidden = false;
  errorEl.textContent = msg;
}

function startOrientation() {
  // requestPermission must be called synchronously inside the tap handler on iOS.
  requestOrientationPermission().then((r) => {
    orientState = r;
    orient.start(); // harmless if access was denied: no events arrive
  });
}

$('start').addEventListener('click', () => {
  startOrientation();
  const cam = navigator.mediaDevices?.getUserMedia
    ? openFrontCamera(video, settings.cameraSize)
    : Promise.reject(new Error('Camera API unavailable (needs HTTPS and a supported browser).'));
  errorEl.hidden = true;
  mode = 'camera';
  eyeAnchor = null;
  showHud();
  setStatus('Starting camera…');
  cam
    .then(async ({ caps }) => {
      cameraCaps = caps;
      buildSettings(); // the resolution list now reflects what this camera can deliver
      setStatus('Loading face model…');
      const ft = new FaceTracker(frames);
      await ft.init();
      tracker = ft;
      startPhoneTracker();
    })
    .catch((err) => {
      console.error(err);
      showError(`Could not start tracking: ${err.message || err}`);
    });
});

$('simulate').addEventListener('click', () => {
  startOrientation();
  errorEl.hidden = true;
  mode = 'sim';
  eyeAnchor = null;
  showHud();
  setStatus('Simulated eye');
});

// Simulated eye: pointer position over the screen, wheel for distance.
canvas.addEventListener('pointermove', (e) => {
  if (mode !== 'sim') return;
  const nx = (e.clientX / innerWidth) * 2 - 1;
  const ny = (e.clientY / innerHeight) * 2 - 1;
  simEye.x = nx * screenM.w * 1.5;
  simEye.y = -ny * screenM.h * 1.5;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    if (mode !== 'sim') return;
    e.preventDefault();
    simEye.z = Math.min(1.5, Math.max(0.1, simEye.z * Math.exp(e.deltaY * 0.001)));
  },
  { passive: false }
);

centerBtn.addEventListener('click', () => {
  recenter();
  centerBtn.textContent = 'Recenter';
});

// ---------- settings panel ----------

function fmt(v, step) {
  return step < 1 ? String(+v.toFixed(2)) : String(Math.round(v));
}

function buildSliders(body, list) {
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'setting';
    const id = `set-${s.key}`;
    row.innerHTML = `<label for="${id}">${s.label}</label><output></output><input id="${id}" type="range" min="${s.min}" max="${s.max}" step="${s.step}">${s.hint ? `<span class="hint">${s.hint}</span>` : ''}`;
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    input.value = settings[s.key];
    out.textContent = `${fmt(settings[s.key], s.step)} ${s.unit}`;
    input.addEventListener('input', () => {
      settings[s.key] = parseFloat(input.value);
      out.textContent = `${fmt(settings[s.key], s.step)} ${s.unit}`;
      onSettingChanged(s.key);
      if (s.key === 'eyeDepthOffset') onOffsetSlider();
    });
    body.appendChild(row);
  }
}

function buildSettings() {
  const body = $('settingsBody');
  body.textContent = '';
  buildSliders(body, SLIDERS);

  // Front-camera resolution: from the largest the camera reports down to 640×480 (0.3 MP).
  // Processing always works on a ~0.3 MP copy; a larger size only helps if a camera crops
  // its view at small sizes. Changing it reloads the page.
  const sizes = availableCameraSizes(cameraCaps).map(([w, h]) => `${w}x${h}`);
  if (!sizes.includes(settings.cameraSize)) sizes.push(settings.cameraSize);
  const resRow = document.createElement('div');
  resRow.className = 'setting';
  resRow.innerHTML =
    `<label for="set-cameraSize">Camera resolution</label><output></output>` +
    `<select id="set-cameraSize">${sizes
      .map((s) => {
        const [w, h] = s.split('x').map(Number);
        const mp = ((w * h) / 1e6).toFixed(1);
        return `<option value="${s}"${s === settings.cameraSize ? ' selected' : ''}>${w}×${h} (${mp} MP)</option>`;
      })
      .join('')}</select>` +
    `<span class="hint">Raise only if the camera preview is cropped at the default. Reloads the page.</span>`;
  resRow.querySelector('select').addEventListener('change', (e) => {
    settings.cameraSize = e.target.value;
    saveSettings();
    location.reload();
  });
  body.appendChild(resRow);
  for (const s of TOGGLES) {
    const row = document.createElement('label');
    row.className = 'setting toggle';
    row.innerHTML = `<input type="checkbox"><span>${s.label}</span>`;
    const input = row.querySelector('input');
    input.checked = settings[s.key];
    input.addEventListener('change', () => {
      settings[s.key] = input.checked;
      onSettingChanged(s.key);
    });
    body.appendChild(row);
  }

  // Developer tool: measure this model's front-camera FOV once, for the table in windowMath.js.
  const dev = document.createElement('div');
  dev.className = 'setting';
  dev.innerHTML =
    '<button type="button">Measure camera FOV (developer)</button>' +
    '<span class="hint">Hold your eyes a measured distance from the screen, then tap.</span>';
  dev.querySelector('button').addEventListener('click', measureCameraFov);
  body.appendChild(dev);
}

function measureCameraFov() {
  if (mode !== 'camera' || track.lost) {
    alert('Start the camera and keep your face in view first.');
    return;
  }
  const answer = prompt('Distance from your eyes to the screen, in cm:', '40');
  const trueDist = parseFloat(answer) / 100;
  if (!(trueDist > 0.05)) return;
  const fov = fovForMeasuredDistance(settings.fovDeg, eyeRaw.z, trueDist);
  settings.fovDeg = Math.round(fov * 10) / 10;
  settings.eyeDepth = 1; // the FOV now accounts for distance
  saveSettings();
  buildSettings();
  const key = screenModelKey(screen.width, screen.height, devicePixelRatio);
  alert(`Camera FOV set to ${settings.fovDeg}°.\nFor the per-model table: '${key}': ${settings.fovDeg},`);
}

function onSettingChanged(key) {
  if (key === 'smoothing' || key === 'rotationSmoothing') applySmoothing();
  if (key === 'showPreview') video.classList.toggle('preview', settings.showPreview);
  if (key === 'useOrientation') recenter();
  if (key === 'phoneTracking') settings.phoneTracking ? startPhoneTracker() : stopPhoneTracker();
  saveSettings();
}

// The user moved the offset slider: their value wins over the automatic fit.
function onOffsetSlider() {
  settings.eyeOffsetManual = true;
  saveSettings();
}

function setSettingsOpen(open) {
  settingsPanel.hidden = !open;
  $('settingsToggle').setAttribute('aria-expanded', String(open));
}

$('settingsToggle').addEventListener('click', () => setSettingsOpen(settingsPanel.hidden));
$('settingsClose').addEventListener('click', () => setSettingsOpen(false));
$('settingsReset').addEventListener('click', () => {
  Object.assign(settings, DEFAULTS);
  buildSettings();
  for (const key of Object.keys(DEFAULTS)) onSettingChanged(key);
});

buildSettings();
video.classList.toggle('preview', settings.showPreview);
