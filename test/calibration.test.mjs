import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MotionScaleEstimator, fitEyeCorrection } from '../src/calibration.js';
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
const waveAcc = (t) => [
  -0.08 * (2 * Math.PI * 1.3) ** 2 * Math.sin(2 * Math.PI * 1.3 * t),
  -0.05 * (2 * Math.PI * 1.7) ** 2 * Math.sin(2 * Math.PI * 1.7 * t + 1),
  -0.03 * (2 * Math.PI * 1.1) ** 2 * Math.sin(2 * Math.PI * 1.1 * t + 2),
];

test('motion scale is recovered from tracker positions and the accelerometer', () => {
  const metersPerUnit = 0.25;
  const est = new MotionScaleEstimator();
  const imuFrame = yaw(70); // accelerometer reports in a different frame: magnitudes still match
  let tv = 0;
  for (let t = 0; t < 6; t += 0.01) {
    est.addImu(rotate(imuFrame, waveAcc(t)), t);
    if (t >= tv) {
      est.addPosition(wave(t).map((v) => v / metersPerUnit), t);
      tv += 1 / 30;
    }
  }
  assert.ok(est.scale !== null, 'expected an estimate');
  assert.ok(Math.abs(est.scale / metersPerUnit - 1) < 0.1, `scale ${est.scale} vs ${metersPerUnit}`);
});

test('no estimate while the phone is still', () => {
  const est = new MotionScaleEstimator();
  for (let t = 0; t < 3; t += 1 / 30) {
    est.addImu([0, 0, 0], t);
    est.addPosition([1, 2, 3], t);
  }
  assert.equal(est.scale, null);
});

test('eye corrections are recovered when the head stays still and the phone moves', () => {
  const E = [0.02, 0.05, 0.35]; // fixed eye in the world
  const c = [0, 0.08, 0]; // camera above the screen center
  const trueLateral = 1.1; // face tracking under-reads sideways offsets by 10%
  const trueDepth = 0.8; // and over-reads distance by 25%
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
    const u = [uTrue[0] / trueLateral, uTrue[1] / trueLateral, uTrue[2] / trueDepth];
    samples.push({ p, q: qr, u, c });
  }
  const fit = fitEyeCorrection(samples);
  assert.ok(fit, 'expected a fit');
  assert.ok(Math.abs(fit.lateral - trueLateral) < 1e-6, `lateral ${fit.lateral}`);
  assert.ok(Math.abs(fit.depth - trueDepth) < 1e-6, `depth ${fit.depth}`);
  fit.eye.forEach((v, i) => assert.ok(Math.abs(v - E[i]) < 1e-6));
  assert.ok(fit.rms < 1e-9);
});
