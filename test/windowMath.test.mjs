import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  screenSizeMeters,
  eyeFromIris,
  knownCssPpi,
  fovForMeasuredDistance,
  irisDiameterPx,
  matrixTranslation,
  IRIS_DIAMETER_M,
} from '../src/windowMath.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const CAL = { ipdM: 0.064, fovLongDeg: 90, camOffsetM: 0, flipX: false };

test('screen size converts CSS px to meters', () => {
  const s = screenSizeMeters(96, 192, 96); // 1 inch × 2 inches
  near(s.w, 0.0254);
  near(s.h, 0.0508);
});

test('eye distance comes from the iris gap and IPD', () => {
  // 640px-wide video, 90° FOV → f = 320px. A 64px iris gap with a 64mm IPD → z = 0.32 m.
  const eye = eyeFromIris({ x: 0.45, y: 0.5, z: 0 }, { x: 0.55, y: 0.5, z: 0 }, 640, 480, CAL, 0);
  near(eye.z, 0.32, 1e-6);
  near(eye.x, 0, 1e-9);
});

test('known iPhone screens map to CSS px per inch in either orientation', () => {
  near(knownCssPpi(390, 844, 3), 460 / 3);
  near(knownCssPpi(844, 390, 3), 460 / 3);
  assert.equal(knownCssPpi(1920, 1080, 1), null);
});

test('iris size reference gives distance', () => {
  // f = 320px (640px wide, 90° FOV). An 11.7 mm iris spanning 9.36 px → 0.40 m.
  const circle = (cx, r) => [
    { x: cx + r, y: 0.5 }, { x: cx, y: 0.5 + r * (640 / 480) },
    { x: cx - r, y: 0.5 }, { x: cx, y: 0.5 - r * (640 / 480) },
  ];
  const r = 9.36 / 2 / 640;
  const irisPx = irisDiameterPx([circle(0.45, r), circle(0.55, r)], 640, 480);
  near(irisPx, 9.36, 1e-9);
  const eye = eyeFromIris({ x: 0.45, y: 0.5, z: 0 }, { x: 0.55, y: 0.5, z: 0 }, 640, 480, CAL, 0, {
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

test('measured distance gives the field of view that reproduces it', () => {
  // With 90° the eye reads 0.32 m; if the truth is 0.40 m, the new FOV must read 0.40 m.
  const fov = fovForMeasuredDistance(90, 0.32, 0.4);
  const cal = { ...CAL, fovLongDeg: fov };
  const eye = eyeFromIris({ x: 0.45, y: 0.5, z: 0 }, { x: 0.55, y: 0.5, z: 0 }, 640, 480, cal, 0);
  near(eye.z, 0.4, 1e-9);
});

test('viewer moving toward image-left maps to screen +x', () => {
  const eye = eyeFromIris({ x: 0.35, y: 0.5, z: 0 }, { x: 0.45, y: 0.5, z: 0 }, 640, 480, CAL, 0);
  assert.ok(eye.x > 0);
});
