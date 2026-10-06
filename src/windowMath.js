// Pure math for the "screen as a window" effect. No Three.js imports so it can
// be unit-tested under node.

const INCH = 0.0254;

// Physical display size (portrait width × height, mm) of known iPhones, from Apple's specs
// (native pixels / PPI). Browsers don't expose physical size, so the model is identified by
// its CSS screen size and pixel ratio. 375×812@3 is shared by the X/XS/11 Pro and the
// 12/13 mini (5.4"); the X/XS/11 Pro size is used.
const IPHONE_DISPLAY_MM = {
  '375x667@2': [58.4, 103.9], // SE 2nd/3rd gen
  '414x896@2': [64.5, 139.6], // XR, 11
  '375x812@3': [62.4, 135.1], // X, XS, 11 Pro
  '414x896@3': [68.9, 149.1], // XS Max, 11 Pro Max
  '428x926@3': [71.2, 154.1], // 12/13 Pro Max, 14 Plus
  '390x844@3': [64.6, 139.8], // 12, 13, 14, 12/13 Pro
  '393x852@3': [65.1, 141.1], // 14 Pro, 15, 15 Pro, 16
  '402x874@3': [66.6, 144.8], // 16 Pro, 17, 17 Pro
  '420x912@3': [69.6, 151.1], // Air
  '430x932@3': [71.2, 154.4], // 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  '440x956@3': [72.9, 158.4], // 16/17 Pro Max
};

// Display height to assume when the device's real size isn't known.
export const FALLBACK_DISPLAY_HEIGHT_M = { mobile: 2.5 * INCH, desktop: 8 * INCH };

// Key identifying the device by its portrait CSS screen size and pixel ratio.
export function screenModelKey(screenW, screenH, dpr) {
  return `${Math.min(screenW, screenH)}x${Math.max(screenW, screenH)}@${Math.round(dpr)}`;
}

// Physical display size in meters, portrait-oriented like the screen values passed in.
// Known iPhones come from the table; otherwise the fallback height is used, and the width
// follows the screen's aspect ratio. Returns { w, h, known }.
export function displaySizeM(screenW, screenH, dpr, isMobile) {
  const mm = IPHONE_DISPLAY_MM[screenModelKey(screenW, screenH, dpr)];
  const portrait = screenH >= screenW;
  if (mm) {
    const [pw, ph] = mm; // portrait width, height
    return portrait
      ? { w: pw / 1000, h: ph / 1000, known: true }
      : { w: ph / 1000, h: pw / 1000, known: true };
  }
  const h = isMobile ? FALLBACK_DISPLAY_HEIGHT_M.mobile : FALLBACK_DISPLAY_HEIGHT_M.desktop;
  return { w: h * (screenW / screenH), h, known: false };
}

// Size of the visible page (the window we render into) in meters: the fraction of the
// display it covers, times the display's physical size. Only ratios of screen values are used.
export function pageSizeM(display, pageW, pageH, screenW, screenH) {
  return { w: display.w * (pageW / screenW), h: display.h * (pageH / screenH) };
}

// Front-camera field of view (degrees, long side of the video Safari delivers), measured
// once per model with Settings → "Measure camera FOV" at a known distance. Keyed like
// IPHONE_DISPLAY_MM. The automatic calibration refines this per session.
const FRONT_CAMERA_FOV = {
  // '390x844@3': 0, // add measured values here
};

export function knownFrontCameraFov(screenW, screenH, dpr) {
  return FRONT_CAMERA_FOV[screenModelKey(screenW, screenH, dpr)] ?? null;
}

// Field of view that makes a measured distance come out right: the face-tracked distance
// scales with the focal length, i.e. with 1 / tan(fov / 2).
export function fovForMeasuredDistance(currentFovDeg, estimatedDist, trueDist) {
  const t = Math.tan((currentFovDeg * Math.PI) / 360) * (estimatedDist / trueDist);
  return (Math.atan(t) * 360) / Math.PI;
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
//   cal         : { ipdM, fovLongDeg, camOffsetM, flipX }
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
  return { x, y, z: dist, ipdPx };
}

export const lerp = (a, b, t) => a + (b - a) * t;

// Frame-rate-independent exponential approach factor for time constant tau (s).
export const approach = (dt, tau) => 1 - Math.exp(-dt / Math.max(tau, 1e-4));
