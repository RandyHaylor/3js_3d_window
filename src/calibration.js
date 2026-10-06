// Automatic calibration. Pure math (no Three.js) so it can be unit-tested under node.
//
// The accelerometer is the only sensor that measures motion in real units, so it sets
// the scale of everything else:
//   1. Motion scale: AlvaAR's positions have an arbitrary unit. Comparing how hard the
//      phone accelerates according to AlvaAR and according to the accelerometer gives
//      meters per AlvaAR unit. Magnitudes are compared, so the two sensors' coordinate
//      frames don't need to be aligned.
//   2. Eye correction: with the phone pose in meters, moving the phone while the head is
//      roughly still means the eye's world position should not move. A least-squares fit
//      finds the lateral and depth corrections to the face-tracked eye position (which
//      depend on the assumed eye/iris size and camera focal length) that make it so.

import { rotate } from './viewModel.js';

const LOWPASS_TAU = 0.12; // s, applied identically to both acceleration signals
const MIN_ACCEL = 0.6; // m/s², only compare samples where the phone is clearly accelerating
const MIN_PAIRS = 40;

function lowpass(prev, next, dt) {
  const a = 1 - Math.exp(-dt / LOWPASS_TAU);
  return prev.map((v, i) => v + (next[i] - v) * a);
}

// Estimates meters per tracker unit from tracker positions and accelerometer readings.
export class MotionScaleEstimator {
  constructor() {
    this.reset();
  }

  reset() {
    this.imuAcc = [0, 0, 0];
    this.imuT = null;
    this.imuHist = []; // recent filtered accelerometer readings { t, mag }
    this.prev = null; // last tracker sample { t, p, v }
    this.visAcc = [0, 0, 0];
    this.sumIV = 0;
    this.sumVV = 0;
    this.pairs = 0;
  }

  // Accelerometer reading without gravity (m/s², any frame), time in seconds.
  addImu(acc, t) {
    if (this.imuT !== null) this.imuAcc = lowpass(this.imuAcc, acc, Math.max(1e-3, t - this.imuT));
    else this.imuAcc = acc.slice();
    this.imuT = t;
    this.imuHist.push({ t, mag: Math.hypot(...this.imuAcc) });
    while (this.imuHist.length && this.imuHist[0].t < t - 1) this.imuHist.shift();
  }

  // Filtered accelerometer magnitude closest to time t.
  imuAt(t) {
    let best = null;
    for (const s of this.imuHist) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best && Math.abs(best.t - t) < 0.05 ? best.mag : null;
  }

  // Tracker position (tracker units), time in seconds.
  addPosition(p, t) {
    const prev = this.prev;
    if (!prev) {
      this.prev = { t, p, v: null };
      return;
    }
    const dt = t - prev.t;
    if (dt <= 1e-3 || dt > 0.25) {
      // Missing frames: restart differentiation rather than invent a jump.
      this.prev = { t, p, v: null };
      return;
    }
    const v = p.map((x, i) => (x - prev.p[i]) / dt);
    if (prev.v) {
      const acc = v.map((x, i) => (x - prev.v[i]) / dt);
      this.visAcc = lowpass(this.visAcc, acc, dt);
      // Backward differences describe the motion about one frame ago.
      this.pair(t - dt);
    }
    this.prev = { t, p, v };
  }

  pair(t) {
    const imu = this.imuAt(t);
    const vis = Math.hypot(...this.visAcc);
    if (imu === null || imu < MIN_ACCEL) return;
    this.sumIV += imu * vis;
    this.sumVV += vis * vis;
    this.pairs++;
  }

  // Meters per tracker unit, or null until enough motion has been seen.
  get scale() {
    return this.pairs >= MIN_PAIRS && this.sumVV > 0 ? this.sumIV / this.sumVV : null;
  }
}

// Solve the n×n linear system A x = b (Gaussian elimination with partial pivoting).
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Fit eye-position corrections from samples taken while the phone moves and the head is
// roughly still. Each sample: { p, q, u, c }
//   p : screen center in the world (meters)       q : screen rotation
//   u : face-tracked eye position relative to the front camera, in the screen frame
//   c : front camera position in the screen frame (meters)
// Model: true eye in screen = c + [a·u.x, a·u.y, b·u.z + δ], and the eye's world position
// p + q·(that) is the same fixed point E for every sample.
// The depth offset δ is only separable from E when the phone also rotates (rotation turns
// the offset's direction while E stays put); without enough rotation pass withOffset=false.
// Returns { lateral: a, depth: b, offset: δ, eye: E, rms } or null if unconstrained.
export function fitEyeCorrection(samples, withOffset = true) {
  if (samples.length < 10) return null;
  const n = withOffset ? 6 : 5;
  const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
  const Atb = new Array(n).fill(0);
  const rows = [];
  for (const s of samples) {
    const lat = rotate(s.q, [s.u[0], s.u[1], 0]);
    const dep = rotate(s.q, [0, 0, s.u[2]]);
    const nrm = rotate(s.q, [0, 0, 1]);
    const base = rotate(s.q, s.c);
    for (let i = 0; i < 3; i++) {
      // a·lat_i + b·dep_i (+ δ·nrm_i) − E_i = −(p_i + base_i)
      const e = [i === 0 ? -1 : 0, i === 1 ? -1 : 0, i === 2 ? -1 : 0];
      const row = withOffset ? [lat[i], dep[i], nrm[i], ...e] : [lat[i], dep[i], ...e];
      const rhs = -(s.p[i] + base[i]);
      rows.push([row, rhs]);
      for (let r = 0; r < n; r++) {
        Atb[r] += row[r] * rhs;
        for (let k = 0; k < n; k++) AtA[r][k] += row[r] * row[k];
      }
    }
  }
  const x = solve(AtA, Atb);
  if (!x) return null;
  let sq = 0;
  for (const [row, rhs] of rows) {
    const e = row.reduce((acc, v, k) => acc + v * x[k], 0) - rhs;
    sq += e * e;
  }
  const [a, b, ...rest] = x;
  const offset = withOffset ? rest[0] : 0;
  const eye = withOffset ? rest.slice(1) : rest;
  return { lateral: a, depth: b, offset, eye, rms: Math.sqrt(sq / rows.length) };
}

// ---------- guideposts ----------
// Through a real window, content at depth D behind it must not shrink in angular size as
// the viewer leans in. With the true distance z and the distance the renderer uses ẑ(z),
// that holds iff  d ln ẑ / d ln z ≤ 1 + ẑ/D  (→ 1 for distant content).

// Elasticity d ln ẑ / d ln z of the raw estimate, given the fitted depth model
// z = b·ẑ + δ (distances measured from the camera). The scale b cancels out: only an
// offset (or other nonlinearity) can break the invariant.
export function rawDistanceElasticity(z, depthOffset) {
  return z / (z - depthOffset);
}

// The invariant's limit for content at depth D, using the distance the renderer uses.
export function angularSizeLimit(zHat, D) {
  return 1 + zHat / D;
}
