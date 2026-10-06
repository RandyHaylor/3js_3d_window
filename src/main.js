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
  windowCamera,
} from './viewModel.js';
import { Vec3Filter } from './filters.js';
import { FaceTracker, openFrontCamera, CAMERA_FORMATS } from './faceTracker.js';
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
  useIris: true, // iris diameter (11.7 mm) is the physical reference for eye scale
  autoEyeCal: false, // automatic eye-correction fit (assumes a still head; off until verified)
  useOrientation: true,
  showPreview: false,
  phoneTracking: true,
  showStats: false, // stats drawer (top-left ▾)
  eyeCamera: false, // false: camera at the window (default); true: camera at the eye, off-axis frustum
  cameraFormat: '640x480', // front-camera format requested from Safari (see CAMERA_FORMATS)
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
  { key: 'pxPerInch', label: 'Screen density', unit: 'css px/in', min: 70, max: 220, step: 1, hint: 'Sets the physical size of the window.' },
  { key: 'ipdMm', label: 'Eye spacing (IPD)', unit: 'mm', min: 50, max: 76, step: 0.5 },
  { key: 'fovDeg', label: 'Camera FOV (long side)', unit: '°', min: 40, max: 100, step: 0.5, hint: 'Check the distance readout against a ruler.' },
  { key: 'camOffsetMm', label: 'Camera above screen top', unit: 'mm', min: -20, max: 30, step: 0.5 },
  { key: 'smoothing', label: 'Smoothing cutoff', unit: 'Hz', min: 0.2, max: 4, step: 0.05, hint: 'Lower = steadier, higher = snappier.' },
];
const TOGGLES = [
  { key: 'flipX', label: 'Flip left/right' },
  { key: 'useIris', label: 'Use iris size for distance (instead of eye spacing)' },
  { key: 'useOrientation', label: 'Use phone orientation' },
  { key: 'showPreview', label: 'Show camera preview' },
  { key: 'phoneTracking', label: 'Phone tracking (AlvaAR room tracking)' },
  { key: 'autoEyeCal', label: 'Automatic eye correction (experimental; assumes a still head)' },
  { key: 'eyeCamera', label: 'Camera at the eye (off-axis) instead of at the window' },
];

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

// The eye in the WORLD frame, placed each frame from the window (phone pose) by face tracking.
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
  if (!alvaRef) {
    alvaRef = cam;
    orient.center(); // AlvaAR and motion-sensor references must be the same moment
  }
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
    // The window is the phone's pose in the world: position from AlvaAR, rotation from the
    // motion sensors when available (AlvaAR's rotation otherwise). The eye is then placed
    // from the window by face tracking; it never moves the window.
    const useImu = settings.useOrientation && orient.hasData;
    const q = useImu ? { x: phoneQ.x, y: phoneQ.y, z: phoneQ.z, w: phoneQ.w } : measured.q;
    s = screenFromPose(measured.p, q, screenM.w, screenM.h);
    const e = rotate(q, eyeS);
    eyeAnchor = [s.center[0] + e[0], s.center[1] + e[1], s.center[2] + e[2]];
    view.source = 'AlvaAR';
    view.measuredQ = measured.q;
    if (!track.lost && settings.autoEyeCal) updateEyeCorrection(measured, t);
  } else {
    // No measured position: the phone stays at the world origin. Its rotation (if used)
    // only turns the window; the eye is always placed from the phone by face tracking.
    eyeAnchor = rotate(phoneQ, eyeS);
    s = screenInWorld(eyeAnchor, phoneQ, eyeS, screenM.w, screenM.h);
    view.source = settings.useOrientation && orient.hasData ? 'phone fixed, rotation on' : 'phone fixed';
  }

  const d = generalizedPerspective(s.pa, s.pb, s.pc, eyeAnchor, NEAR).d; // eye → screen plane
  if (!(d > 0.02)) return false; // eye at or behind the screen plane
  view.phoneW = s.center;
  view.d = d;

  if (!settings.eyeCamera) {
    // Window camera (default): the camera sits at the window, looks along the eye → phone
    // vector, and its field of view is the angle the screen covers from the eye.
    const wc = windowCamera(eyeAnchor, s, screenM.w, screenM.h);
    camera.position.fromArray(wc.position);
    camera.up.fromArray(wc.up);
    camera.lookAt(wc.position[0] + wc.dir[0], wc.position[1] + wc.dir[1], wc.position[2] + wc.dir[2]);
    camera.fov = wc.fovDeg;
    camera.aspect = wc.aspect;
    camera.near = 0.01;
    camera.far = FAR;
    camera.updateProjectionMatrix();
    return true;
  }

  // Eye camera: at the eye, image plane = the screen (off-axis frustum through its corners).
  // A window only shows what is behind it: the near clipping plane IS the screen plane,
  // so anything between the viewer and the glass is clipped (cut at the frame).
  const near = d * 0.999;
  const p = generalizedPerspective(s.pa, s.pb, s.pc, eyeAnchor, near);
  camera.projectionMatrix.makePerspective(p.left, p.right, p.top, p.bottom, near, FAR);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  basis.makeBasis(vr.fromArray(p.vr), vu.fromArray(p.vu), vn.fromArray(p.vn));
  camera.quaternion.setFromRotationMatrix(basis);
  camera.position.fromArray(eyeAnchor);
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
    lines.push(`camera: asked ${settings.cameraFormat}, got ${video.videoWidth}×${video.videoHeight}  FOV setting ${settings.fovDeg}°`);
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
    ? openFrontCamera(video, settings.cameraFormat)
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

  // Front-camera format: how much of the sensor Safari delivers (field of view). Applying
  // a new format restarts the page so the camera and trackers start fresh.
  const fmtRow = document.createElement('div');
  fmtRow.className = 'setting';
  const options = Object.keys(CAMERA_FORMATS)
    .map((k) => `<option value="${k}"${k === settings.cameraFormat ? ' selected' : ''}>${k}</option>`)
    .join('');
  fmtRow.innerHTML =
    `<label for="set-cameraFormat">Front camera format</label><output></output>` +
    `<select id="set-cameraFormat">${options}</select>` +
    `<span class="hint">Pick the one whose preview shows the most of the room. Reloads the page.</span>`;
  fmtRow.querySelector('select').addEventListener('change', (e) => {
    settings.cameraFormat = e.target.value;
    saveSettings();
    location.reload();
  });
  body.appendChild(fmtRow);

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
  for (const key of Object.keys(DEFAULTS)) onSettingChanged(key);
});

buildSettings();
video.classList.toggle('preview', settings.showPreview);
