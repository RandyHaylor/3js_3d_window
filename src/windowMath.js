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

// Browsers don't expose physical screen size, so iPhones are identified by their
// portrait CSS size and pixel ratio. Values are PPI / scale, from ios-resolution.com.
// 375×812@3 is shared by the X/XS/11 Pro (458 ppi) and the 12/13 mini (476 ppi);
// the more common 458 is used.
const IPHONE_CSS_PPI = {
  '375x667@2': 163, // SE 2nd/3rd gen
  '414x896@2': 163, // XR, 11
  '375x812@3': 458 / 3,
  '414x896@3': 458 / 3, // XS Max, 11 Pro Max
  '428x926@3': 458 / 3, // 12/13 Pro Max, 14 Plus
  '390x844@3': 460 / 3, // 12, 13, 14, 17e
  '393x852@3': 460 / 3, // 14 Pro, 15, 15 Pro, 16
  '402x874@3': 460 / 3, // 16 Pro, 17, 17 Pro
  '420x912@3': 460 / 3, // Air
  '430x932@3': 460 / 3, // 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  '440x956@3': 460 / 3, // 16/17 Pro Max
};

// CSS px per inch for a known iPhone, or null.
export function knownCssPpi(screenW, screenH, dpr) {
  const w = Math.min(screenW, screenH), h = Math.max(screenW, screenH);
  return IPHONE_CSS_PPI[`${w}x${h}@${Math.round(dpr)}`] ?? null;
}

// Human iris diameter is nearly constant: 11.7 ± 0.5 mm (MediaPipe Iris).
export const IRIS_DIAMETER_M = 0.0117;

// Mean iris diameter in px. `irises` holds, per eye, the 4 iris boundary landmarks;
// opposite points (0–2, 1–3) give two diameters per eye.
export function irisDiameterPx(irises, videoW, videoH) {
  let sum = 0;
  let n = 0;
  for (const p of irises) {
    for (const [i, j] of [[0, 2], [1, 3]]) {
      sum += Math.hypot((p[i].x - p[j].x) * videoW, (p[i].y - p[j].y) * videoH);
      n++;
    }
  }
  return n ? sum / n : 0;
}

// Translation of MediaPipe's 4×4 face transform. The flattening order isn't documented;
// in either order the three non-translation slots are zero, so take the non-zero triple.
export function matrixTranslation(d) {
  const tail = Math.abs(d[12]) + Math.abs(d[13]) + Math.abs(d[14]);
  const side = Math.abs(d[3]) + Math.abs(d[7]) + Math.abs(d[11]);
  return tail >= side ? [d[12], d[13], d[14]] : [d[3], d[7], d[11]];
}

// Convert iris-center landmarks to an eye-midpoint position in the screen frame.
//   left, right : {x, y, z} normalized MediaPipe landmarks (468 / 473)
//   videoW/H    : video frame size in px
//   cal         : { ipdM, fovLongDeg, camOffsetM, flipX, depthScale }
//   screenH     : physical screen height in meters (camera sits above the top edge)
//   ref         : optional { px, m } size reference used for distance instead of eye spacing
export function eyeFromIris(left, right, videoW, videoH, cal, screenH, ref = null) {
  const longSide = Math.max(videoW, videoH);
  const f = longSide / 2 / Math.tan((cal.fovLongDeg * Math.PI) / 360);

  const dx = (left.x - right.x) * videoW;
  const dy = (left.y - right.y) * videoH;
  const dz = (left.z - right.z) * videoW; // MediaPipe z uses roughly the same scale as x
  const ipdPx = Math.hypot(dx, dy, dz);
  if (!(ipdPx > 1)) return null;

  const u = ((left.x + right.x) / 2) * videoW;
  const v = ((left.y + right.y) / 2) * videoH;

  const dist = ref && ref.px > 1 ? (f * ref.m) / ref.px : (f * cal.ipdM) / ipdPx;
  // The raw front-camera image is not mirrored: when the viewer moves to their right,
  // they move toward the image's left (-u). Screen +x is the viewer's right.
  const sx = cal.flipX ? 1 : -1;
  const x = (sx * (u - videoW / 2) * dist) / f;
  const y = (-(v - videoH / 2) * dist) / f + screenH / 2 + cal.camOffsetM;
  // depthScale only scales distance: that stretches the scene's depth uniformly,
  // while scaling x/y with it would make depth stretch more as the viewer leans in.
  const z = dist * cal.depthScale;
  return { x, y, z, ipdPx };
}

export const lerp = (a, b, t) => a + (b - a) * t;

// Frame-rate-independent exponential approach factor for time constant tau (s).
export const approach = (dt, tau) => 1 - Math.exp(-dt / Math.max(tau, 1e-4));
