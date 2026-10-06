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

// Face scale: meters per AlvaAR unit, with the face as the size reference. Face tracking
// measures the eye relative to the phone in meters (iris size). The eye's world position is
//   eye = k·a + c
// where k·a is the phone's AlvaAR position (a in AlvaAR units, k meters per unit) and c is
// everything already in meters (the camera-offset part of the phone's pose plus the eye
// relative to the phone, placed by the phone's rotation). With the head still, eye is
// constant, so the k that keeps k·a + c steadiest over the last WINDOW seconds is the scale
// (least squares: k = −Σ(a−ā)·(c−c̄) / Σ|a−ā|²).
// It only measures when the phone moves relative to the head (c varies by MIN_C_RMS), and
// only accepts fits that explain the motion (the eye stays within MAX_RMS, and well under
// how much c moved). Walking with the phone steady in front of the face gives nothing to
// measure, so it waits rather than guess.
const WINDOW = 2.5; // s
const MIN_SAMPLES = 15;
const MIN_C_RMS = 0.015; // m: phone moved relative to the head
const MAX_RMS = 0.012; // m: how still the fitted eye must stay
const KEEP = 9; // accepted fits; the scale is their median

export class FaceScaleEstimator {
  constructor() {
    this.reset();
  }

  // A new AlvaAR map has a new unit: start over.
  reset() {
    this.samples = [];
    this.fits = [];
    this.scale = null;
    this.last = null; // latest fit attempt, for diagnostics
  }

  // a: the phone's AlvaAR position (units), c: the meters part (see above), t: seconds.
  add(a, c, t) {
    const s = this.samples;
    s.push({ a, c, t });
    while (s.length && s[0].t < t - WINDOW) s.shift();
    if (s.length < MIN_SAMPLES) return;
    const n = s.length;
    const am = [0, 1, 2].map((i) => s.reduce((v, x) => v + x.a[i], 0) / n);
    const cm = [0, 1, 2].map((i) => s.reduce((v, x) => v + x.c[i], 0) / n);
    let saa = 0;
    let sac = 0;
    let scc = 0;
    for (const x of s) {
      for (let i = 0; i < 3; i++) {
        const da = x.a[i] - am[i];
        const dc = x.c[i] - cm[i];
        saa += da * da;
        sac += da * dc;
        scc += dc * dc;
      }
    }
    const cRms = Math.sqrt(scc / n);
    if (cRms < MIN_C_RMS || saa <= 0) return void (this.last = { cRms });
    const k = -sac / saa;
    // Residual: how much the fitted eye still moves.
    const rms = Math.sqrt(Math.max(0, (scc + 2 * k * sac + k * k * saa) / n));
    this.last = { k, rms, cRms };
    if (!(k > 0) || rms > MAX_RMS || rms > 0.3 * cRms) return;
    this.fits.push(k);
    if (this.fits.length > KEEP) this.fits.shift();
    const sorted = [...this.fits].sort((x, y) => x - y);
    this.scale = sorted[sorted.length >> 1];
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
