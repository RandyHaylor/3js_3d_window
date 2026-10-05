import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offAxisFrustum, screenSizeMeters, eyeFromIris, lockDepth } from '../src/windowMath.js';

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

test('viewer moving toward image-left maps to screen +x', () => {
  const cal = { ipdM: 0.064, fovLongDeg: 90, camOffsetM: 0, flipX: false, depthScale: 1 };
  const eye = eyeFromIris({ x: 0.35, y: 0.5, z: 0 }, { x: 0.45, y: 0.5, z: 0 }, 640, 480, cal, 0);
  assert.ok(eye.x > 0);
});

test('locking depth keeps distance fixed and preserves direction from the camera', () => {
  const camY = 0.08;
  const locked = lockDepth({ x: 0.1, y: camY + 0.05, z: 0.3 }, 0.6, camY);
  near(locked.z, 0.6);
  near(locked.x, 0.2); // same angle, twice the distance
  near(locked.y, camY + 0.1);
});
