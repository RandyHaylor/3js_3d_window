import * as THREE from 'three';
import { createScene } from './scene.js';
import {
  offAxisFrustum,
  screenSizeMeters,
  eyeFromIris,
  knownCssPpi,
  irisDiameterPx,
  matrixTranslation,
  IRIS_DIAMETER_M,
  approach,
} from './windowMath.js';
import { Vec3Filter } from './filters.js';
import { FaceTracker, openFrontCamera } from './faceTracker.js';
import { OrientationTracker, requestOrientationPermission } from './orientation.js';

const NEAR = 0.005;
const FAR = 6;
const LOST_AFTER = 0.25; // s without a face before showing "Face lost"
const DRIFT_AFTER = 2.0; // s lost before easing back to the neutral eye

const IS_PHONE = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;

// ---------- settings ----------

const DEFAULTS = {
  pxPerInch: knownCssPpi(screen.width, screen.height, devicePixelRatio) ?? (IS_PHONE ? 153 : 96),
  ipdMm: 63,
  fovDeg: 70,
  camOffsetMm: 5,
  depthScale: 1,
  worldScale: 1,
  smoothing: 1,
  flipX: false,
  useIris: false,
  useOrientation: true,
  showPreview: false,
};

const SLIDERS = [
  { key: 'pxPerInch', label: 'Screen density', unit: 'css px/in', min: 70, max: 220, step: 1, hint: 'Sets the physical size of the window.' },
  { key: 'ipdMm', label: 'Eye spacing (IPD)', unit: 'mm', min: 50, max: 76, step: 0.5 },
  { key: 'fovDeg', label: 'Camera FOV (long side)', unit: '°', min: 40, max: 100, step: 0.5, hint: 'Check the z readout against a ruler.' },
  { key: 'camOffsetMm', label: 'Camera above screen top', unit: 'mm', min: -20, max: 30, step: 0.5 },
  { key: 'smoothing', label: 'Smoothing cutoff', unit: 'Hz', min: 0.2, max: 4, step: 0.05, hint: 'Lower = steadier, higher = snappier.' },
];
// Quick-access sliders in the top-corner Adjust drawer.
const ADJUST = [
  { key: 'depthScale', label: 'Depth', unit: '×', min: 0.3, max: 3, step: 0.01 },
  { key: 'worldScale', label: 'Scale', unit: '×', min: 0.1, max: 2, step: 0.01 },
];
const TOGGLES = [
  { key: 'flipX', label: 'Flip left/right' },
  { key: 'useIris', label: 'Use iris size for distance (instead of eye spacing)' },
  { key: 'useOrientation', label: 'Use phone orientation' },
  { key: 'showPreview', label: 'Show camera preview' },
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
const rig = new THREE.Object3D(); // the phone: screen at its origin, +z toward the viewer
const targetQ = new THREE.Quaternion();

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

const neutralEye = () => ({ x: 0, y: 0, z: IS_PHONE ? 0.33 : 0.6 });
const eye = neutralEye(); // the eye position actually used for rendering
const simEye = neutralEye();

const filter = new Vec3Filter();
function applySmoothing() {
  filter.setParams({ minCutoff: settings.smoothing, beta: 8 }, { minCutoff: settings.smoothing * 0.6, beta: 4 });
}
applySmoothing();

const track = { lastSeen: -Infinity, lost: true, blendUntil: 0, filtered: null, ipdPx: 0 };

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
const distStats = { eyes: new Jitter(), iris: new Jitter(), face: new Jitter() };

const calibration = () => ({
  ipdM: settings.ipdMm / 1000,
  fovLongDeg: settings.fovDeg,
  camOffsetM: settings.camOffsetMm / 1000,
  flipX: settings.flipX,
  depthScale: settings.depthScale,
});

function moveToward(p, target, k) {
  p.x += (target.x - p.x) * k;
  p.y += (target.y - p.y) * k;
  p.z += (target.z - p.z) * k;
}

function updateTracking(t, nowMs, dt) {
  const r = tracker ? tracker.detect(nowMs) : undefined;
  if (r) {
    const cal = calibration();
    const iris = { px: irisDiameterPx(r.irises, r.videoW, r.videoH), m: IRIS_DIAMETER_M };
    const e = eyeFromIris(r.a, r.b, r.videoW, r.videoH, cal, screenM.h, settings.useIris ? iris : null);

    // Raw distances from each source (before Depth scaling), for the debug comparison.
    const raw = { ...cal, depthScale: 1 };
    const byEyes = eyeFromIris(r.a, r.b, r.videoW, r.videoH, raw, screenM.h);
    const byIris = eyeFromIris(r.a, r.b, r.videoW, r.videoH, raw, screenM.h, iris);
    if (byEyes) distStats.eyes.add(byEyes.z);
    if (byIris) distStats.iris.add(byIris.z);
    if (r.faceMatrix) distStats.face.add(Math.abs(matrixTranslation(r.faceMatrix)[2]) / 100);

    if (e) {
      if (track.lost) {
        filter.reset();
        track.blendUntil = t + 0.5;
        track.lost = false;
      }
      track.lastSeen = t;
      track.ipdPx = e.ipdPx;
      track.filtered = filter.filter(e, t);
    }
  }

  const since = t - track.lastSeen;
  if (since > LOST_AFTER) track.lost = true;

  if (!track.lost && track.filtered) {
    if (t < track.blendUntil) moveToward(eye, track.filtered, approach(dt, 0.12));
    else Object.assign(eye, track.filtered);
  } else if (since > DRIFT_AFTER) {
    moveToward(eye, neutralEye(), approach(dt, 1.5));
  } // else: hold the last position

  if (!tracker) setStatus('Loading face model…');
  else if (track.lost) setStatus('Face lost: hold steady', 'warn');
  else setStatus('Tracking', 'ok');
}

function updateCamera(dt) {
  if (settings.useOrientation) orient.relative(targetQ);
  else targetQ.identity();
  rig.quaternion.slerp(targetQ, approach(dt, 0.04));

  const f = offAxisFrustum(eye, screenM.w, screenM.h, NEAR);
  camera.projectionMatrix.makePerspective(f.left, f.right, f.top, f.bottom, NEAR, FAR);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.position.set(eye.x, eye.y, f.eyeZ).applyQuaternion(rig.quaternion).add(rig.position);
  camera.quaternion.copy(rig.quaternion);
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

  if (mode === 'camera') updateTracking(t, nowMs, dt);
  else if (mode === 'sim') moveToward(eye, simEye, approach(dt, 0.05));

  setWorldScale(settings.worldScale);
  updateCamera(dt);
  renderer.render(scene, camera);

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

function renderDebug() {
  const cm = (v) => (v * 100).toFixed(1).padStart(6);
  const lines = [
    `eye  x${cm(eye.x)}  y${cm(eye.y)}  z${cm(eye.z)} cm`,
    `screen ${(screenM.w * 100).toFixed(1)}×${(screenM.h * 100).toFixed(1)} cm   ${fps.toFixed(0)} fps`,
    `orientation: ${orientState}`,
  ];
  if (mode === 'camera') {
    lines.push(`face: ${tracker ? tracker.delegate : 'loading'}  ipd ${track.ipdPx.toFixed(1)} px`);
    const d = distStats;
    lines.push(`dist cm  eyes ${d.eyes.text()}  iris ${d.iris.text()}  face ${d.face.text()}`);
    lines.push(`using ${settings.useIris ? 'iris' : 'eyes'}   ${settings.pxPerInch.toFixed(1)} css px/in`);
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
    if (r === 'granted') orient.start();
  });
}

$('start').addEventListener('click', () => {
  startOrientation();
  const cam = navigator.mediaDevices?.getUserMedia
    ? openFrontCamera(video)
    : Promise.reject(new Error('Camera API unavailable (needs HTTPS and a supported browser).'));
  errorEl.hidden = true;
  mode = 'camera';
  showHud();
  setStatus('Starting camera…');
  cam
    .then(async () => {
      setStatus('Loading face model…');
      const ft = new FaceTracker(video);
      await ft.init();
      tracker = ft;
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
  orient.center();
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
}

function onSettingChanged(key) {
  if (key === 'pxPerInch') resize();
  if (key === 'smoothing') applySmoothing();
  if (key === 'showPreview') video.classList.toggle('preview', settings.showPreview);
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
