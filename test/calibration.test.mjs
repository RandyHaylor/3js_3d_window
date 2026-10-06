import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FaceScaleEstimator,
  fitEyeCorrection,
  rawDistanceElasticity,
  angularSizeLimit,
} from '../src/calibration.js';
import { rotate } from '../src/viewModel.js';

const yaw = (deg) => {
  const h = (deg * Math.PI) / 360;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
};
const pitch = (deg) => {
  const h = (deg * Math.PI) / 360;
  return { x: Math.sin(h), y: 0, z: 0, w: Math.cos(h) };
};

// Phone waved around: a few centimeters at about 1–2 Hz on each axis (meters).
const wave = (t) => [0.08 * Math.sin(2 * Math.PI * 1.3 * t), 0.05 * Math.sin(2 * Math.PI * 1.7 * t + 1), 0.03 * Math.sin(2 * Math.PI * 1.1 * t + 2)];

let seed = 1;
const noise = () => {
  // deterministic pseudo-random, roughly uniform in [-1, 1]
  seed = (seed * 16807) % 2147483647;
  return (seed / 2147483647) * 2 - 1;
};

// Feeds the face-scale estimator 30 fps samples for `seconds`: the phone at world position
// phone(t) (meters), the eye at world position eye(t), AlvaAR reporting the phone in units
// of `metersPerUnit`. Face tracking gives the eye relative to the phone (in meters, plus
// `faceNoise`), placed in the world by the phone's rotation: c = eye − phone.
function runFaceScale(est, { seconds, phone, eye, metersPerUnit = 0.26, faceNoise = 0 }) {
  for (let i = 0; i <= seconds * 30; i++) {
    const t = i / 30;
    const p = phone(t);
    const e = eye(t);
    const a = p.map((v) => v / metersPerUnit);
    const c = e.map((v, j) => v - p[j] + faceNoise * noise());
    est.add(a, c, t);
  }
  return est.scale;
}
const STILL_EYE = () => [0.02, 0.05, 0.35];

test('face scale: AlvaAR units → meters from a still head and a moving phone', () => {
  const k = runFaceScale(new FaceScaleEstimator(), { seconds: 2.5, phone: wave, eye: STILL_EYE });
  assert.ok(k !== null, 'expected an estimate');
  assert.ok(Math.abs(k / 0.26 - 1) < 0.01, `scale ${k}`);
});

test('face scale survives face-tracking noise (±5 mm)', () => {
  const k = runFaceScale(new FaceScaleEstimator(), { seconds: 2.5, phone: wave, eye: STILL_EYE, faceNoise: 0.005 });
  assert.ok(k !== null, 'expected an estimate');
  assert.ok(Math.abs(k / 0.26 - 1) < 0.1, `scale ${k}`);
});

test('face scale: walking with the phone steady in front of the face gives no estimate', () => {
  // Head and phone move together at 1 m/s: nothing relates AlvaAR's units to the face.
  const walk = (t) => [0.02 * Math.sin(t * 3), 0, -1 * t];
  const k = runFaceScale(new FaceScaleEstimator(), {
    seconds: 3,
    phone: walk,
    eye: (t) => walk(t).map((v, i) => v + STILL_EYE()[i]),
  });
  assert.equal(k, null);
});

test('face scale: a head moving on its own during the motion is rejected', () => {
  const k = runFaceScale(new FaceScaleEstimator(), {
    seconds: 2.5,
    phone: wave,
    eye: (t) => [0.02 + 0.12 * Math.sin(t * 2.3), 0.05, 0.35 + 0.08 * Math.sin(t * 1.7)],
  });
  assert.equal(k, null);
});

test('face scale: no estimate while the phone is still', () => {
  const k = runFaceScale(new FaceScaleEstimator(), { seconds: 3, phone: () => [0, 0, 0], eye: STILL_EYE });
  assert.equal(k, null);
});

// Samples of a phone waved and tilted in front of a still eye at E, with face tracking
// that mis-reads the eye: true = c + [lateral·u.x, lateral·u.y, depth·u.z + offset].
function headStillSamples(E, c, trueLateral, trueDepth, trueOffset) {
  const samples = [];
  for (let i = 0; i < 60; i++) {
    const t = i / 30;
    const q = { ...yaw(10 * Math.sin(t * 2)) };
    const qq = { x: q.x, y: q.y, z: q.z, w: q.w };
    const qr = (() => {
      // compose yaw and pitch: pitch then yaw
      const a = qq, b = pitch(8 * Math.sin(t * 3));
      return {
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      };
    })();
    const p = wave(t);
    // True eye in the screen frame, then what face tracking would report.
    const inv = { x: -qr.x, y: -qr.y, z: -qr.z, w: qr.w };
    const eyeS = rotate(inv, [E[0] - p[0], E[1] - p[1], E[2] - p[2]]);
    const uTrue = [eyeS[0] - c[0], eyeS[1] - c[1], eyeS[2] - c[2]];
    const u = [uTrue[0] / trueLateral, uTrue[1] / trueLateral, (uTrue[2] - trueOffset) / trueDepth];
    samples.push({ p, q: qr, u, c });
  }
  return samples;
}

test('eye corrections are recovered when the head stays still and the phone moves', () => {
  const E = [0.02, 0.05, 0.35]; // fixed eye in the world
  const c = [0, 0.08, 0]; // camera above the screen center
  // Sideways offsets under-read by 10%, distance over-read by 25%, no offset.
  const fit = fitEyeCorrection(headStillSamples(E, c, 1.1, 0.8, 0));
  assert.ok(fit, 'expected a fit');
  assert.ok(Math.abs(fit.lateral - 1.1) < 1e-6, `lateral ${fit.lateral}`);
  assert.ok(Math.abs(fit.depth - 0.8) < 1e-6, `depth ${fit.depth}`);
  assert.ok(Math.abs(fit.offset) < 1e-6, `offset ${fit.offset}`);
  fit.eye.forEach((v, i) => assert.ok(Math.abs(v - E[i]) < 1e-6));
  assert.ok(fit.rms < 1e-9);
});

test('a depth offset (distance read too close by a fixed amount) is recovered', () => {
  const E = [0.02, 0.05, 0.35];
  const c = [0, 0.08, 0];
  const fit = fitEyeCorrection(headStillSamples(E, c, 1, 1, 0.04));
  assert.ok(fit, 'expected a fit');
  assert.ok(Math.abs(fit.offset - 0.04) < 1e-6, `offset ${fit.offset}`);
  assert.ok(Math.abs(fit.depth - 1) < 1e-6, `depth ${fit.depth}`);
});

test('guidepost: an offset breaks the angular-size invariant up close, a scale does not', () => {
  // Distance read 4 cm too close: at 20 cm the raw estimate falls 25% faster than truth.
  const e20 = rawDistanceElasticity(0.2, 0.04);
  assert.ok(Math.abs(e20 - 1.25) < 1e-9);
  assert.ok(e20 > angularSizeLimit(0.16, 2)); // violates for content 2 m behind the screen
  // No offset: elasticity 1, within the limit for any depth.
  assert.equal(rawDistanceElasticity(0.2, 0), 1);
  assert.ok(1 <= angularSizeLimit(0.2, 2));
});
