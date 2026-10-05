import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotate, screenInWorld, generalizedPerspective, IDENTITY } from '../src/viewModel.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const nearV = (a, b, eps = 1e-9) => a.forEach((v, i) => near(v, b[i], eps));
const yaw = (deg) => {
  const h = (deg * Math.PI) / 360;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
};

const W = 0.07;
const H = 0.15;

test('eye centered in front of an unrotated screen gives a symmetric frustum', () => {
  const eyeS = [0, 0, 0.35];
  const s = screenInWorld([0, 0, 0.35], IDENTITY, eyeS, W, H);
  const p = generalizedPerspective(s.pa, s.pb, s.pc, [0, 0, 0.35], 0.01);
  near(p.left, -p.right);
  near(p.bottom, -p.top);
  near(p.d, 0.35);
});

test('phone rotating in place with the head still keeps the screen where it physically is', () => {
  // Real world: head fixed at E, phone pivots 40° about its own center at the origin.
  const E = [0, 0, 0.35];
  const q = yaw(40);
  // Face tracking would measure the eye in the rotated screen's frame:
  const qInv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
  const eyeS = rotate(qInv, E);
  const s = screenInWorld(E, q, eyeS, W, H);
  nearV(s.center, [0, 0, 0]);
  nearV(s.pb, rotate(q, [W / 2, -H / 2, 0]));
});

test('rays from the eye pass through the physical screen corners', () => {
  // Oblique view: eye off to the side of a rotated screen.
  const E = [0.05, 0.02, 0.3];
  const q = yaw(-25);
  const qInv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
  const eyeS = rotate(qInv, sub3(E, [0.01, 0, 0])); // screen center at (0.01, 0, 0)
  const s = screenInWorld(E, q, eyeS, W, H);
  const p = generalizedPerspective(s.pa, s.pb, s.pc, E, 0.01);
  // Scaling the near-plane extents to the screen plane must land on the corners.
  const toPlane = p.d / 0.01;
  near(p.left * toPlane, dot3(p.vr, sub3(s.pa, E)));
  near(p.right * toPlane, dot3(p.vr, sub3(s.pb, E)));
  near(p.top * toPlane, dot3(p.vu, sub3(s.pc, E)));
  // And the screen normal faces the eye.
  assert.ok(p.d > 0);
});

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
