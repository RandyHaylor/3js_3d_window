// Pure math for the "screen as a window" effect. No Three.js imports so it can
// be unit-tested under node.

const MIN_EYE_Z = 0.05; // meters; keeps the frustum finite if tracking misbehaves

// Off-axis frustum bounds at the near plane for a screen of size w×h (meters)
// centered at the origin in the z=0 plane, viewed from eye {x,y,z} (z > 0).
export function offAxisFrustum(eye, w, h, near) {
  const ez = Math.max(eye.z, MIN_EYE_Z);
  const k = near / ez;
  return {
    left: (-w / 2 - eye.x) * k,
    right: (w / 2 - eye.x) * k,
    bottom: (-h / 2 - eye.y) * k,
    top: (h / 2 - eye.y) * k,
    eyeZ: ez,
  };
}

// Physical screen size in meters from CSS pixel size and CSS px per inch.
export function screenSizeMeters(cssW, cssH, cssPxPerInch) {
  const m = 0.0254 / cssPxPerInch;
  return { w: cssW * m, h: cssH * m };
}

// Convert iris-center landmarks to an eye-midpoint position in the screen frame.
//   left, right : {x, y, z} normalized MediaPipe landmarks (468 / 473)
//   videoW/H    : video frame size in px
//   cal         : { ipdM, fovLongDeg, camOffsetM, flipX, depthScale }
//   screenH     : physical screen height in meters (camera sits above the top edge)
export function eyeFromIris(left, right, videoW, videoH, cal, screenH) {
  const longSide = Math.max(videoW, videoH);
  const f = longSide / 2 / Math.tan((cal.fovLongDeg * Math.PI) / 360);

  const dx = (left.x - right.x) * videoW;
  const dy = (left.y - right.y) * videoH;
  const dz = (left.z - right.z) * videoW; // MediaPipe z uses roughly the same scale as x
  const ipdPx = Math.hypot(dx, dy, dz);
  if (!(ipdPx > 1)) return null;

  const u = ((left.x + right.x) / 2) * videoW;
  const v = ((left.y + right.y) / 2) * videoH;

  const z = ((f * cal.ipdM) / ipdPx) * cal.depthScale;
  // The raw front-camera image is not mirrored: when the viewer moves to their right,
  // they move toward the image's left (-u). Screen +x is the viewer's right.
  const sx = cal.flipX ? 1 : -1;
  const x = (sx * (u - videoW / 2) * z) / f;
  const y = (-(v - videoH / 2) * z) / f + screenH / 2 + cal.camOffsetM;
  return { x, y, z, ipdPx };
}

// Pin the eye to a fixed distance so leaning in/out does not stretch the scene's
// depth. The eye keeps its direction as seen from the camera (camY above screen
// center), so lateral/vertical parallax is unchanged.
export function lockDepth(eye, lockedZ, camY) {
  const k = lockedZ / eye.z;
  return { x: eye.x * k, y: (eye.y - camY) * k + camY, z: lockedZ };
}

export const lerp = (a, b, t) => a + (b - a) * t;

// Frame-rate-independent exponential approach factor for time constant tau (s).
export const approach = (dt, tau) => 1 - Math.exp(-dt / Math.max(tau, 1e-4));
