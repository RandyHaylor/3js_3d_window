import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rotate,
  screenInWorld,
  generalizedPerspective,
  IDENTITY,
  qmul,
  CAM_IN_SCREEN,
  screenPoseFromCamera,
  relativePose,
  screenFromPose,
} from '../src/viewModel.js';

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

test('a near plane at the screen distance puts the frustum edges exactly on the screen', () => {
  // Window clipping: with near = eye-to-screen distance, the near plane is the glass itself.
  const E = [0.03, -0.02, 0.35];
  const s = screenInWorld(E, yaw(15), rotate({ x: 0, y: -Math.sin(Math.PI / 24), z: 0, w: Math.cos(Math.PI / 24) }, E), W, H);
  const d = generalizedPerspective(s.pa, s.pb, s.pc, E, 0.01).d;
  const p = generalizedPerspective(s.pa, s.pb, s.pc, E, d);
  near(p.right - p.left, W, 1e-9); // the near-plane rectangle is the screen
  near(p.top - p.bottom, H, 1e-9);
});

test('screen pose is recovered from the tracked front-camera pose', () => {
  // A screen yawed 30° with its center at P; the camera sits 8 cm above the center.
  const qS = yaw(30);
  const P = [0.2, -0.1, 0.5];
  const camOffset = [0, 0.08, 0];
  const k = 0.25; // meters per tracker unit
  const qCam = qmul(qS, CAM_IN_SCREEN);
  const tCam = add3(P, rotate(qS, camOffset)).map((v) => v / k);

  const pose = screenPoseFromCamera(qCam, tCam, k, camOffset);
  nearV(pose.p, P);
  nearV(rotate(pose.q, [1, 0, 0]), rotate(qS, [1, 0, 0]));
  nearV(rotate(pose.q, [0, 0, 1]), rotate(qS, [0, 0, 1]));
});

test('the front camera looks toward the viewer (+z of the screen)', () => {
  // A Three.js-style camera looks down its −z; for the front camera that is screen +z.
  nearV(rotate(CAM_IN_SCREEN, [0, 0, -1]), [0, 0, 1]);
  nearV(rotate(CAM_IN_SCREEN, [1, 0, 0]), [-1, 0, 0]); // image right = screen left
});

test('recentering makes the reference pose the origin and moves others with it', () => {
  const ref = { q: yaw(40), p: [1, 2, 3] };
  const later = { q: qmul(yaw(40), yaw(10)), p: add3([1, 2, 3], rotate(yaw(40), [0.3, 0, 0])) };
  const r0 = relativePose(ref, ref);
  nearV(r0.p, [0, 0, 0]);
  nearV(rotate(r0.q, [1, 0, 0]), [1, 0, 0]);
  const r1 = relativePose(ref, later);
  nearV(r1.p, [0.3, 0, 0]); // moved 30 cm along the phone's own x
  nearV(rotate(r1.q, [1, 0, 0]), rotate(yaw(10), [1, 0, 0]));
});

test('screen corners follow the screen pose', () => {
  const s = screenFromPose([0, 0, 0], IDENTITY, W, H);
  nearV(s.pa, [-W / 2, -H / 2, 0]);
  nearV(s.pc, [-W / 2, H / 2, 0]);
});

function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
