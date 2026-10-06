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

// Compared quantity: the change in average velocity between two consecutive tracker frame
// intervals. From the tracker: (p2−p1)/h2 − (p1−p0)/h1. From the accelerometer: the
// acceleration integrated over both intervals with a triangular weight (0 → 1 → 0). The two
// are equal for any frame spacing, so this works at low camera frame rates too.
const MIN_DV = 0.05; // m/s, only compare windows with clear motion
const MAX_GAP = 0.6; // s between tracker frames; longer is a dropout
const SPAN = 0.15; // s, minimum spacing of the three frames compared (tracker jitter matters less)
const MIN_PAIRS = 20;
export const MIN_SCALE_PAIRS = MIN_PAIRS;

// Estimates meters per tracker unit from tracker positions and accelerometer readings.
export class MotionScaleEstimator {
  constructor() {
    this.reset();
  }

  reset() {
    this.imu = []; // recent accelerometer samples { t, a }
    this.frames = []; // recent tracker samples { t, p }, contiguous (no dropouts)
    this.sumIV = 0;
    this.sumVV = 0;
    this.pairs = 0;
    // Diagnostics: how many accelerometer samples / comparison windows were seen, and why
    // windows were rejected.
    this.diag = { imuSamples: 0, positions: 0, windows: 0, noImuCoverage: 0, tooLittleMotion: 0 };
  }

  // Accelerometer reading without gravity (m/s², any frame), time in seconds.
  addImu(acc, t) {
    this.diag.imuSamples++;
    this.imu.push({ t, a: acc });
    while (this.imu.length && this.imu[0].t < t - 3) this.imu.shift();
  }

  // Tracker position (tracker units), time in seconds.
  addPosition(p, t) {
    this.diag.positions++;
    const f = this.frames;
    if (f.length && (t - f[f.length - 1].t > MAX_GAP || t <= f[f.length - 1].t)) f.length = 0;
    f.push({ t, p });
    while (f.length && f[0].t < t - 2) f.shift();
    // Newest frame, plus the latest frames at least SPAN before it and before that.
    const f2 = f[f.length - 1];
    let f1 = null;
    let f0 = null;
    for (let i = f.length - 2; i >= 0; i--) {
      if (!f1) {
        if (f[i].t <= f2.t - SPAN) f1 = f[i];
      } else if (f[i].t <= f1.t - SPAN) {
        f0 = f[i];
        break;
      }
    }
    if (f0) this.pair(f0, f1, f2);
  }

  pair(f0, f1, f2) {
    const h1 = f1.t - f0.t;
    const h2 = f2.t - f1.t;
    const dvVis = [0, 1, 2].map((i) => (f2.p[i] - f1.p[i]) / h2 - (f1.p[i] - f0.p[i]) / h1);
    this.diag.windows++;
    const dvImu = this.integrate(f0.t, f1.t, f2.t);
    if (!dvImu) {
      this.diag.noImuCoverage++;
      return;
    }
    const imu = Math.hypot(...dvImu);
    const vis = Math.hypot(...dvVis);
    this.lastWindow = { t: f2.t, dvImu: imu, dvVis: vis };
    if (imu < MIN_DV) {
      this.diag.tooLittleMotion++;
      return;
    }
    this.sumIV += imu * vis;
    this.sumVV += vis * vis;
    this.pairs++;
  }

  // ∫ a(τ)·k(τ) dτ over [t0, t2], k rising 0→1 on [t0, t1] and falling 1→0 on [t1, t2].
  // Returns null if the accelerometer samples don't cover the window.
  integrate(t0, t1, t2) {
    const s = this.imu.filter((x) => x.t >= t0 - 0.02 && x.t <= t2 + 0.02);
    if (s.length < 2 || s[0].t > t0 + 0.05 || s[s.length - 1].t < t2 - 0.05) return null;
    const k = (tau) => (tau <= t1 ? (tau - t0) / (t1 - t0) : (t2 - tau) / (t2 - t1));
    const out = [0, 0, 0];
    for (let i = 1; i < s.length; i++) {
      const a = Math.max(t0, s[i - 1].t);
      const b = Math.min(t2, s[i].t);
      if (b <= a) continue;
      const mid = (a + b) / 2;
      const w = Math.max(0, k(mid)) * (b - a);
      for (let j = 0; j < 3; j++) out[j] += ((s[i - 1].a[j] + s[i].a[j]) / 2) * w;
    }
    return out;
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
