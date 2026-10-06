import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displaySizeM,
  pageSizeM,
  eyeFromIris,
  fovForMeasuredDistance,
  irisDiameterPx,
  matrixTranslation,
  IRIS_DIAMETER_M,
} from '../src/windowMath.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const CAL = { ipdM: 0.064, fovLongDeg: 90, camOffsetM: 0, flipX: false };

test('known iPhone display size comes from the table, in meters', () => {
  const d = displaySizeM(428, 926, 3, true); // 12/13 Pro Max
  assert.equal(d.known, true);
  near(d.w, 0.0712);
  near(d.h, 0.1541);
  const land = displaySizeM(926, 428, 3, true); // same phone in landscape
  near(land.w, 0.1541);
  near(land.h, 0.0712);
});

test('unknown displays use 2.5 in (mobile) or 8 in (desktop) height', () => {
  const m = displaySizeM(360, 800, 2, true);
  assert.equal(m.known, false);
  near(m.h, 2.5 * 0.0254);
  near(m.w, 2.5 * 0.0254 * (360 / 800));
  near(displaySizeM(1920, 1080, 1, false).h, 8 * 0.0254);
});

test('the visible page is the same fraction of the display in meters', () => {
  const page = pageSizeM({ w: 0.0712, h: 0.1541 }, 428, 751, 428, 926);
  near(page.w, 0.0712);
  near(page.h, 0.1541 * (751 / 926));
});

test('eye distance comes from the iris gap and IPD', () => {
  // 640px-wide video, 90° FOV → f = 320px. A 64px iris gap with a 64mm IPD → z = 0.32 m.
  const eye = eyeFromIris({ x: 0.45, y: 0.5, z: 0 }, { x: 0.55, y: 0.5, z: 0 }, 640, 480, CAL, 0);
  near(eye.z, 0.32, 1e-6);
  near(eye.x, 0, 1e-9);
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
