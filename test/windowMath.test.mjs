import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  offAxisFrustum,
  screenSizeMeters,
  eyeFromIris,
  knownCssPpi,
  irisDiameterPx,
  matrixTranslation,
  IRIS_DIAMETER_M,
} from '../src/windowMath.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('frustum is symmetric when the eye is centered', () => {
  const f = offAxisFrustum({ x: 0, y: 0, z: 0.3 }, 0.07, 0.15, 0.01);
  near(f.left, -f.right);
  near(f.bottom, -f.top);
});

test('moving the eye right shifts the frustum left (see more of the left side)', () => {
  const centered = offAxisFrustum({ x: 0, y: 0, z: 0.3 }, 0.07, 0.15, 0.01);
  const right = offAxisFrustum({ x: 0.05, y: 0, z: 0.3 }, 0.07, 0.15, 0.01);
  assert.ok(right.left < centered.left);
  assert.ok(right.right < centered.right);
});

test('screen size converts CSS px to meters', () => {
  const s = screenSizeMeters(96, 192, 96); // 1 inch × 2 inches
  near(s.w, 0.0254);
  near(s.h, 0.0508);
});

test('eye distance comes from the iris gap and IPD', () => {
  // 640px-wide video, 90° FOV → f = 320px. A 64px iris gap with a 64mm IPD → z = 0.32 m.
  const cal = { ipdM: 0.064, fovLongDeg: 90, camOffsetM: 0, flipX: false, depthScale: 1 };
  const a = { x: 0.45, y: 0.5, z: 0 };
  const b = { x: 0.55, y: 0.5, z: 0 };
  const eye = eyeFromIris(a, b, 640, 480, cal, 0);
  near(eye.z, 0.32, 1e-6);
  near(eye.x, 0, 1e-9);
});

test('depth scale changes distance only, not lateral position', () => {
  const base = { ipdM: 0.064, fovLongDeg: 90, camOffsetM: 0, flipX: false, depthScale: 1 };
  const a = { x: 0.35, y: 0.5, z: 0 }, b = { x: 0.45, y: 0.5, z: 0 };
  const e1 = eyeFromIris(a, b, 640, 480, base, 0);
  const e2 = eyeFromIris(a, b, 640, 480, { ...base, depthScale: 2 }, 0);
  near(e2.z, e1.z * 2);
  near(e2.x, e1.x);
});

test('known iPhone screens map to CSS px per inch in either orientation', () => {
  near(knownCssPpi(390, 844, 3), 460 / 3);
  near(knownCssPpi(844, 390, 3), 460 / 3);
  assert.equal(knownCssPpi(1920, 1080, 1), null);
});

test('iris size reference gives distance', () => {
  // f = 320px (640px wide, 90° FOV). An 11.7 mm iris spanning 9.36 px → 0.40 m.
  const cal = { ipdM: 0.064, fovLongDeg: 90, camOffsetM: 0, flipX: false, depthScale: 1 };
  const circle = (cx, r) => [
    { x: cx + r, y: 0.5 }, { x: cx, y: 0.5 + r * (640 / 480) },
    { x: cx - r, y: 0.5 }, { x: cx, y: 0.5 - r * (640 / 480) },
  ];
  const r = 9.36 / 2 / 640;
  const irisPx = irisDiameterPx([circle(0.45, r), circle(0.55, r)], 640, 480);
  near(irisPx, 9.36, 1e-9);
  const eye = eyeFromIris({ x: 0.45, y: 0.5, z: 0 }, { x: 0.55, y: 0.5, z: 0 }, 640, 480, cal, 0, {
    px: irisPx,
    m: IRIS_DIAMETER_M,
  });
  near(eye.z, 0.4, 1e-9);
});

test('face matrix translation is read in either flattening order', () => {
  const colMajor = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, -40, 1];
  const rowMajor = [1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, -40, 0, 0, 0, 1];
  assert.deepEqual(matrixTranslation(colMajor), [2, 3, -40]);
  assert.deepEqual(matrixTranslation(rowMajor), [2, 3, -40]);
});

test('viewer moving toward image-left maps to screen +x', () => {
  const cal = { ipdM: 0.064, fovLongDeg: 90, camOffsetM: 0, flipX: false, depthScale: 1 };
  const eye = eyeFromIris({ x: 0.35, y: 0.5, z: 0 }, { x: 0.45, y: 0.5, z: 0 }, 640, 480, cal, 0);
  assert.ok(eye.x > 0);
});
