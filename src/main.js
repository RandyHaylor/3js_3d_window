import * as THREE from 'three';
import { createScene } from './scene.js';
import {
  screenSizeMeters,
  eyeFromIris,
  knownCssPpi,
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
  fitEyeCorrection,
  rawDistanceElasticity,
  angularSizeLimit,
} from './calibration.js';
import {
  rotate,
  screenInWorld,
  generalizedPerspective,
  screenPoseFromCamera,
  relativePose,
  screenFromPose,
} from './viewModel.js';
import { Vec3Filter } from './filters.js';
import { FaceTracker, openFrontCamera } from './faceTracker.js';
import { PhoneTracker } from './phoneTracker.js';
import { OrientationTracker, requestOrientationPermission } from './orientation.js';

const NEAR = 0.005;
const FAR = 6;
const LOST_AFTER = 0.25; // s without a face before the view is blanked

const IS_PHONE = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;

// ---------- settings ----------

const DEFAULTS = {
  pxPerInch: knownCssPpi(screen.width, screen.height, devicePixelRatio) ?? (IS_PHONE ? 153 : 96),
  ipdMm: 63,
  fovDeg: knownFrontCameraFov(screen.width, screen.height, devicePixelRatio) ?? 70,
  camOffsetMm: 5,
  worldScale: 1,
  smoothing: 1,
  flipX: false,
  useIris: false,
  useOrientation: true,
  showPreview: false,
  phoneTracking: true,
  showStats: false, // stats drawer (top-left ▾)
  // Automatic eye-position corrections (see calibration.js), kept between visits.
  eyeLateral: 1,
  eyeDepth: 1,
  eyeDepthOffset: 0, // meters
  eyeOffsetManual: false, // set when the user adjusts the offset; stops the auto fit changing it
};

const SLIDERS = [
  { key: 'pxPerInch', label: 'Screen density', unit: 'css px/in', min: 70, max: 220, step: 1, hint: 'Sets the physical size of the window.' },
  { key: 'ipdMm', label: 'Eye spacing (IPD)', unit: 'mm', min: 50, max: 76, step: 0.5 },
  { key: 'fovDeg', label: 'Camera FOV (long side)', unit: '°', min: 40, max: 100, step: 0.5, hint: 'Check the distance readout against a ruler.' },
  { key: 'camOffsetMm', label: 'Camera above screen top', unit: 'mm', min: -20, max: 30, step: 0.5 },
  { key: 'smoothing', label: 'Smoothing cutoff', unit: 'Hz', min: 0.2, max: 4, step: 0.05, hint: 'Lower = steadier, higher = snappier.' },
];
// Quick-access sliders in the top-corner Adjust drawer.
const ADJUST = [
  { key: 'worldScale', label: 'Scale', unit: '×', min: 0.1, max: 2, step: 0.01 },
  {
    key: 'eyeDepthOffset',
    label: 'Distance offset',
    unit: 'm',
    min: -0.1,
    max: 0.3,
    step: 0.005,
    hint: 'Added to the measured eye distance. Raise it if leaning in changes the view too much.',
  },
];
const TOGGLES = [
  { key: 'flipX', label: 'Flip left/right' },
  { key: 'useIris', label: 'Use iris size for distance (instead of eye spacing)' },
  { key: 'useOrientation', label: 'Use phone orientation' },
  { key: 'showPreview', label: 'Show camera preview' },
  { key: 'phoneTracking', label: 'Phone tracking (AlvaAR room tracking)' },
];

const STORAGE_KEY = '3d-window-settings-v1';
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

let screenM = { w: 0.07, h: 0.15 };
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  screenM = screenSizeMeters(innerWidth, innerHeight, settings.pxPerInch);
}
addEventListener('resize', resize);
resize();

// ---------- state ----------

let mode = 'idle'; // idle | camera | sim
let tracker = null;
const orient = new OrientationTracker();
let orientState = 'off';

// The eye in the SCREEN frame (meters): what face tracking measures.
const neutralEye = () => ({ x: 0, y: 0, z: IS_PHONE ? 0.33 : 0.6 });
const eye = neutralEye();
const simEye = neutralEye();

// The eye in the WORLD frame: the anchor everything is built from. Set when the eye is
// first seen and on Center. Phone movement isn't sensed, so the head is held still here
// and the phone's world position is derived from it.
let eyeAnchor = null;
const phoneQ = new THREE.Quaternion();
const view = { phoneW: [0, 0, 0], d: 0, source: '' }; // for the debug readout

const filter = new Vec3Filter();
function applySmoothing() {
  filter.setParams({ minCutoff: settings.smoothing, beta: 8 }, { minCutoff: settings.smoothing * 0.6, beta: 4 });
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
addEventListener('devicemotion', (e) => {
  const a = e.acceleration; // without gravity, m/s²
  if (a && a.x !== null) motionScale.addImu([a.x, a.y, a.z], performance.now() / 1000);
});

// Face-tracked eye before the automatic correction (screen frame, meters).
const eyeRaw = neutralEye();
const camInScreen = () => [0, screenM.h / 2 + settings.camOffsetMm / 1000, 0];

// Apply the eye correction: lateral offsets are rescaled, and distance from the camera
// follows the fitted depth model true = b·raw + δ.
function correctEye(raw) {
  const c = camInScreen();
  return {
    x: c[0] + (raw.x - c[0]) * settings.eyeLateral,
    y: c[1] + (raw.y - c[1]) * settings.eyeLateral,
    z: c[2] + (raw.z - c[2]) * settings.eyeDepth + settings.eyeDepthOffset,
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
  camOffsetM: settings.camOffsetMm / 1000,
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
  const pt = new PhoneTracker(video);
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
  const r = tracker ? tracker.detect(nowMs) : undefined;
  // A new video frame arrived (r is null when it has no face).
  if (r !== undefined && phoneTracker) {
    const pt = phoneTracker;
    pt.update(r ? r.box : null);
    if (pt.resets !== seenResets) {
      seenResets = pt.resets; // new map: new origin and new scale
      resetCalibration();
    }
    if (pt.status === 'tracking' && pt.position) motionScale.addPosition(pt.position, performance.now() / 1000);
  }
  if (r) {
    const cal = calibration();
    const iris = { px: irisDiameterPx(r.irises, r.videoW, r.videoH), m: IRIS_DIAMETER_M };
    const byEyes = eyeFromIris(r.a, r.b, r.videoW, r.videoH, cal, screenM.h);
    const byIris = eyeFromIris(r.a, r.b, r.videoW, r.videoH, cal, screenM.h, iris);
    if (byEyes) distStats.eyes.add(byEyes.z);
    // Diagnostic: eye spacing from the 2D landmark positions only (no MediaPipe depth term).
    const by2d = eyeFromIris({ ...r.a, z: 0 }, { ...r.b, z: 0 }, r.videoW, r.videoH, cal, screenM.h);
    if (by2d) distStats.eyes2d.add(by2d.z);
    if (byIris) distStats.iris.add(byIris.z);
    if (r.faceMatrix) distStats.face.add(Math.abs(matrixTranslation(r.faceMatrix)[2]) / 100);

    const e = settings.useIris ? byIris : byEyes;
    if (e) {
      if (track.lost) {
        filter.reset();
        track.lost = false;
      }
      track.lastSeen = t;
      track.ipdPx = e.ipdPx;
      Object.assign(eyeRaw, filter.filter(e, t));
      Object.assign(eye, correctEye(eyeRaw));
    }
  }
  if (t - track.lastSeen > LOST_AFTER) track.lost = true;

  const pt = phoneTracker;
  if (!tracker) setStatus('Loading face model…');
  else if (track.lost) setStatus('No eyes detected', 'warn');
  else if (pt && pt.status !== 'tracking') setStatus('Finding the room: move the phone slowly');
  else if (pt && motionScale.scale === null) setStatus('Calibrating: move the phone around gently');
  else setStatus('Tracking', 'ok');
}

// Eye-first camera: anchor eye in the world → screen placement → rays from the eye
// through the screen corners (generalized perspective projection).
const basis = new THREE.Matrix4();
const vr = new THREE.Vector3();
const vu = new THREE.Vector3();
const vn = new THREE.Vector3();

// Phone pose measured by AlvaAR (front camera), as a Three.js-style camera pose using
// the same conversion as AlvaAR's own Three.js connector.
const alvaM = new THREE.Matrix4();
const alvaQ = new THREE.Quaternion();
let alvaRef = null; // raw camera pose at Recenter; the screen pose there becomes the origin
let alvaResets = 0;

function alvaCameraPose(pose) {
  alvaM.fromArray(pose);
  alvaQ.setFromRotationMatrix(alvaM);
  return { q: { x: -alvaQ.x, y: alvaQ.y, z: alvaQ.z, w: alvaQ.w }, t: [pose[12], -pose[13], -pose[14]] };
}

// Screen pose in our world (meters, relative to the Recenter pose) from AlvaAR, or null.
function measuredPhonePose() {
  const pt = phoneTracker;
  const k = motionScale.scale; // meters per AlvaAR unit; null until calibrated
  if (!pt || pt.status !== 'tracking' || !pt.pose || k === null) return null;
  if (pt.resets !== alvaResets) {
    alvaResets = pt.resets; // new map: new origin and scale
    alvaRef = null;
  }
  const cam = alvaCameraPose(pt.pose);
  if (!alvaRef) alvaRef = cam;
  const ref = screenPoseFromCamera(alvaRef.q, alvaRef.t, k, camInScreen());
  const now = screenPoseFromCamera(cam.q, cam.t, k, camInScreen());
  return relativePose(ref, now);
}

function updateCamera(t) {
  const eyeS = [eye.x, eye.y, eye.z];
  let s;
  if (settings.useOrientation) orient.relative(phoneQ);
  else phoneQ.identity();

  const measured = measuredPhonePose();
  if (measured) {
    // Measured phone pose: the screen's corners are where the phone really is, and the
    // eye is placed from the phone by face tracking. Nothing is assumed to stay still.
    s = screenFromPose(measured.p, measured.q, screenM.w, screenM.h);
    const e = rotate(measured.q, eyeS);
    eyeAnchor = [s.center[0] + e[0], s.center[1] + e[1], s.center[2] + e[2]];
    view.source = 'AlvaAR';
    view.measuredQ = measured.q;
    if (!track.lost) updateEyeCorrection(measured, t);
  } else {
    // Handheld (rotation data present): the head is the steady thing, so the eye stays
    // anchored and the phone's placement is derived from it. Fixed monitor (no rotation
    // data): the screen is the steady thing, so it stays at the origin and the eye moves.
    const handheld = settings.useOrientation && orient.hasData;
    if (!eyeAnchor || !handheld) eyeAnchor = rotate(phoneQ, eyeS);
    s = screenInWorld(eyeAnchor, phoneQ, eyeS, screenM.w, screenM.h);
    view.source = handheld ? 'head held still' : 'fixed screen';
  }

  const p = generalizedPerspective(s.pa, s.pb, s.pc, eyeAnchor, NEAR);
  if (!(p.d > 0.02)) return false; // eye at or behind the screen plane

  camera.projectionMatrix.makePerspective(p.left, p.right, p.top, p.bottom, NEAR, FAR);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  basis.makeBasis(vr.fromArray(p.vr), vu.fromArray(p.vu), vn.fromArray(p.vn));
  camera.quaternion.setFromRotationMatrix(basis);
  camera.position.fromArray(eyeAnchor);

  view.phoneW = s.center;
  view.d = p.d;
  return true;
}

function recenter() {
  orient.center();
  if (settings.useOrientation) orient.relative(phoneQ);
  else phoneQ.identity();
  eyeAnchor = rotate(phoneQ, [eye.x, eye.y, eye.z]); // phone back at the world origin
  alvaRef = null; // measured phone pose: the current pose becomes the origin
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

  // Without the eye there is nothing meaningful to show.
  const hasEye = mode !== 'camera' || (tracker && !track.lost);
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
  debugToggle.setAttribute('aria-expanded', String(open));
  debugToggle.setAttribute('aria-label', open ? 'Hide stats' : 'Show stats');
}
debugToggle.addEventListener('click', () => {
  setStatsOpen(!settings.showStats);
  if (settings.showStats) renderDebug();
  saveSettings();
});
setStatsOpen(settings.showStats);

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
    `screen ${(screenM.w * 100).toFixed(1)}×${(screenM.h * 100).toFixed(1)} cm  ${settings.pxPerInch.toFixed(1)} px/in  ${fps.toFixed(0)} fps`,
  ];
  if (mode === 'camera') {
    const d = distStats;
    lines.push(`dist cm  eyes ${d.eyes.text()}  2D ${d.eyes2d.text()}  iris ${d.iris.text()}  face ${d.face.text()}`);
    lines.push(`face: ${tracker ? tracker.delegate : 'loading'}  using ${settings.useIris ? 'iris' : 'eyes'}`);
    if (phoneTracker && view.source === 'AlvaAR') {
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
      lines.push(`eye corr    lateral ${settings.eyeLateral.toFixed(2)} depth ${settings.eyeDepth.toFixed(2)}  ${fitText}`);
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
    ? openFrontCamera(video)
    : Promise.reject(new Error('Camera API unavailable (needs HTTPS and a supported browser).'));
  errorEl.hidden = true;
  mode = 'camera';
  eyeAnchor = null;
  showHud();
  setStatus('Starting camera…');
  cam
    .then(async () => {
      setStatus('Loading face model…');
      const ft = new FaceTracker(video);
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
  if (key === 'pxPerInch') resize();
  if (key === 'smoothing') applySmoothing();
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
  buildAdjust();
  for (const key of Object.keys(DEFAULTS)) onSettingChanged(key);
});

function buildAdjust() {
  const body = $('adjustBody');
  body.textContent = '';
  buildSliders(body, ADJUST);
}

const adjustPanel = $('adjustPanel');
$('adjustToggle').addEventListener('click', () => {
  adjustPanel.hidden = !adjustPanel.hidden;
  $('adjustToggle').setAttribute('aria-expanded', String(!adjustPanel.hidden));
});

buildSettings();
buildAdjust();
video.classList.toggle('preview', settings.showPreview);
