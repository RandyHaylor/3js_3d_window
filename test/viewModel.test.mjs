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
  windowCamera,
  eyeInWorld,
  keystone,
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

test('window camera: at the phone, looking along eye → phone, FOV from eye distance', () => {
  const cam = windowCamera([0, 0, 0.4], [0, 0, 0], W, H);
  nearV(cam.position, [0, 0, 0]);
  nearV(cam.dir, [0, 0, -1]); // eye → phone points into the virtual space
  nearV(cam.up, [0, 1, 0]);
  near(cam.fovDeg, (2 * Math.atan(H / 2 / 0.4) * 180) / Math.PI);
  // Eye moved left: the camera turns to look right, through the window.
  const left = windowCamera([-0.1, 0, 0.4], [0, 0, 0], W, H);
  assert.ok(left.dir[0] > 0);
  // Eye closer: wider field of view.
  assert.ok(windowCamera([0, 0, 0.2], [0, 0, 0], W, H).fovDeg > cam.fovDeg);
});

test('phone rotating in place with the head still does not turn the camera', () => {
  // Head fixed at E, phone pivots about its own center at the origin. Face tracking sees
  // the eye in the rotated phone's frame; the phone rotation places it back in the world.
  const E = [0.04, 0.02, 0.35];
  const still = windowCamera(eyeInWorld([0, 0, 0], IDENTITY, E), [0, 0, 0], W, H);
  for (const q of [yaw(30), qmul(yaw(-20), { x: Math.sin(0.2), y: 0, z: 0, w: Math.cos(0.2) })]) {
    const eyeS = rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, E);
    const turned = windowCamera(eyeInWorld([0, 0, 0], q, eyeS), [0, 0, 0], W, H);
    nearV(turned.dir, still.dir);
    nearV(turned.up, still.up);
    near(turned.fovDeg, still.fovDeg);
  }
});

test('camera roll stays level: up is world up, whatever the eye → phone direction', () => {
  const cam = windowCamera([0.1, 0.3, 0.2], [0, 0, 0], W, H);
  near(dot3(cam.up, cam.dir), 0); // perpendicular to the view direction
  assert.ok(cam.up[1] > 0); // and on the world-up side
  near(cam.up[0] * cam.dir[2] - cam.up[2] * cam.dir[0], 0); // no sideways lean (no roll)
  // Looking straight down (eye directly above the phone) still gives a usable up vector.
  const down = windowCamera([0, 0.4, 0], [0, 0, 0], W, H);
  near(Math.hypot(...down.up), 1);
  near(dot3(down.up, down.dir), 0);
});

// Camera image NDC of world direction v, for a camera looking along dir with level up.
function projectDir(v, dir, up, fovDeg, aspect) {
  const right = normalize3(cross3(dir, up));
  const camUp = cross3(right, dir);
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const z = dot3(v, dir);
  return [dot3(v, right) / z / (t * aspect), dot3(v, camUp) / z / t];
}
const apply = (H, nx, ny) => {
  const c = H.map((r) => r[0] * nx + r[1] * ny + r[2]);
  return [c[0] / c[2], c[1] / c[2]];
};

test('keystone: an untilted screen facing the eye needs no correction', () => {
  const E = [0, 0, 0.4];
  const cam = windowCamera(E, [0, 0, 0], W, H);
  const k = keystone(E, [0, 0, 0], IDENTITY, cam.dir, cam.up, cam.fovDeg, cam.aspect, W, H);
  for (const [nx, ny] of [[0.3, -0.7], [-1, 1], [1, 1]]) nearV(apply(k.H, nx, ny), [nx, ny]);
  near(k.cover, 1, 1e-9);
});

test('keystone: each point of a tilted screen shows the camera image along the eye ray through it', () => {
  const E = [0.03, 0.02, 0.38];
  const P = [0.01, -0.01, 0];
  const q = qmul(yaw(25), { x: Math.sin(0.15), y: 0, z: 0, w: Math.cos(0.15) }); // yawed and pitched
  const cam = windowCamera(E, P, W, H);
  const k = keystone(E, P, q, cam.dir, cam.up, cam.fovDeg, cam.aspect, W, H);
  for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0.2, 0.5]]) {
    const S = add3(P, rotate(q, [(nx * W) / 2, (ny * H) / 2, 0])); // the physical screen point
    nearV(apply(k.H, nx, ny), projectDir(sub3(S, E), cam.dir, cam.up, cam.fovDeg, cam.aspect));
  }
  assert.ok(k.cover > 1); // a tilted screen's corners reach outside the plain view
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
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize3(a) {
  const l = Math.hypot(...a);
  return a.map((v) => v / l);
}
