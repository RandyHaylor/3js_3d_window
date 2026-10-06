import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slerp, RotationHistory, DelayEstimator } from '../src/timeline.js';
import { rotate } from '../src/viewModel.js';

const near = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const yaw = (rad) => ({ x: 0, y: Math.sin(rad / 2), z: 0, w: Math.cos(rad / 2) });
const pitch = (rad) => ({ x: Math.sin(rad / 2), y: 0, z: 0, w: Math.cos(rad / 2) });
const qmul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const inv = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

test('slerp goes the angle-proportional way between rotations', () => {
  const q = slerp(yaw(0), yaw(1), 0.25);
  near(2 * Math.asin(q.y), 0.25, 1e-9);
});

test('rotation history interpolates between samples and clamps outside them', () => {
  const h = new RotationHistory();
  h.push(1, yaw(0));
  h.push(1.1, yaw(0.2));
  h.push(1.2, yaw(0.4));
  near(2 * Math.asin(h.at(1.15).y), 0.3, 1e-9);
  near(2 * Math.asin(h.at(0.5).y), 0, 1e-9);
  near(2 * Math.asin(h.at(9).y), 0.4, 1e-9);
});

// The phone wobbles (yaw and pitch) at 60 Hz sensor rate; the head stays still at E. The
// camera runs at 24 fps and each frame is stamped `delay` seconds after it was captured.
function simulate(delay, seconds = 3, noise = 0) {
  const R = (t) => qmul(yaw(0.4 * Math.sin(2 * Math.PI * 0.7 * t)), pitch(0.2 * Math.sin(2 * Math.PI * 1.1 * t)));
  const hist = new RotationHistory(5);
  for (let t = 0; t <= seconds + 0.5; t += 1 / 60) hist.push(t, R(t));
  const est = new DelayEstimator();
  const E = [0.05, 0.03, 0.35];
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let tf = 0.4; tf <= seconds; tf += 1 / 24) {
    const eyeS = rotate(inv(R(tf - delay)), E).map((v) => v + noise * rand()); // seen at capture time
    est.add(tf, eyeS);
  }
  return est.update((t) => hist.at(t));
}

test('the camera delay is measured from phone rotation and eye direction', () => {
  for (const delay of [0, 0.04, 0.08, 0.15]) near(simulate(delay), delay, 0.006);
});

test('the camera delay survives face-tracking noise (±1 cm per axis)', () => {
  for (const delay of [0.04, 0.1]) near(simulate(delay, 3, 0.01), delay, 0.02);
});

test('no delay estimate without enough phone rotation', () => {
  const hist = new RotationHistory();
  for (let t = 0; t <= 3; t += 1 / 60) hist.push(t, yaw(0.01 * t));
  const est = new DelayEstimator();
  for (let tf = 0; tf <= 3; tf += 1 / 24) est.add(tf, [0, 0, 1]);
  assert.equal(est.update((t) => hist.at(t)), null);
});
