import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MotionScaleEstimator,
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

test('motion scale survives realistic tracker jitter', () => {
  // Tracker positions jitter by ~2 mm (in meters) frame to frame, as visual tracking does.
  const metersPerUnit = 0.25;
  const est = new MotionScaleEstimator();
  let seed = 1;
  const noise = () => {
    // deterministic pseudo-random, roughly uniform in [-1, 1]
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  let tv = 0;
  for (let t = 0; t < 10; t += 0.01) {
    est.addImu(waveAcc(t), t);
    if (t >= tv) {
      const p = wave(t).map((v) => v + 0.002 * noise());
      est.addPosition(p.map((v) => v / metersPerUnit), t);
      tv += 1 / 30;
    }
  }
  assert.ok(est.scale !== null, 'expected an estimate');
  assert.ok(Math.abs(est.scale / metersPerUnit - 1) < 0.15, `scale ${est.scale} vs ${metersPerUnit}`);
});

for (const fps of [10, 5, 3]) {
  test(`motion scale still forms at a low camera frame rate (${fps} fps)`, () => {
    const metersPerUnit = 0.25;
    const est = new MotionScaleEstimator();
    let tv = 0;
    for (let t = 0; t < 20; t += 0.01) {
      est.addImu(waveAcc(t), t);
      if (t >= tv) {
        est.addPosition(wave(t).map((v) => v / metersPerUnit), t);
        tv += 1 / fps;
      }
    }
    assert.ok(est.scale !== null, `no estimate at ${fps} fps (${est.pairs} pairs)`);
    assert.ok(Math.abs(est.scale / metersPerUnit - 1) < 0.1, `scale ${est.scale} at ${fps} fps`);
  });
}

test('no estimate while the phone is still', () => {
  const est = new MotionScaleEstimator();
  for (let t = 0; t < 3; t += 1 / 30) {
    est.addImu([0, 0, 0], t);
    est.addPosition([1, 2, 3], t);
  }
  assert.equal(est.scale, null);
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
