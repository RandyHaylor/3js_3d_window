// Time alignment of the inputs. Pure math (no Three.js) so it can be unit-tested under node.
//
// Every input is stamped with when it was measured, on one clock (seconds, the
// performance.now() timeline):
//   - phone rotation: each orientation event's own timestamp
//   - camera frames: the frame's capture time, minus the measured camera delay
// Each camera frame is then processed in one pass with the phone rotation interpolated to
// that frame's capture time, so the eye is never combined with a rotation from another
// moment.

import { rotate } from './viewModel.js';

// Spherical interpolation between unit quaternions a and b ({x, y, z, w}), u in [0, 1].
export function slerp(a, b, u) {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = d < 0 ? -1 : 1; // take the short way round
  d *= s;
  let ka = 1 - u;
  let kb = u * s;
  if (d < 0.9995) {
    const th = Math.acos(d);
    const sin = Math.sin(th);
    ka = Math.sin((1 - u) * th) / sin;
    kb = (Math.sin(u * th) / sin) * s;
  }
  const q = { x: ka * a.x + kb * b.x, y: ka * a.y + kb * b.y, z: ka * a.z + kb * b.z, w: ka * a.w + kb * b.w };
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

// Timestamped samples of a quaternion, read back at any time by interpolation (clamped to
// the oldest/newest sample outside the recorded span). Keeps the last KEEP seconds.
export class RotationHistory {
  constructor(keep = 2) {
    this.keep = keep;
    this.samples = [];
  }

  push(t, q) {
    const s = this.samples;
    if (s.length && t <= s[s.length - 1].t) return; // out of order or duplicate
    s.push({ t, q: { x: q.x, y: q.y, z: q.z, w: q.w } });
    while (s.length > 2 && s[0].t < t - this.keep) s.shift();
  }

  // True if real samples lie within `window` seconds before AND after t, so the rotation
  // at t is interpolated, not guessed (a gap, or t not yet reached by the stream, fails).
  covers(t, window) {
    const s = this.samples;
    if (!s.length || t < s[0].t || t > s[s.length - 1].t) return false;
    let i = 0;
    while (i < s.length - 1 && s[i + 1].t <= t) i++;
    const after = s[i].t === t ? s[i] : s[i + 1];
    return t - s[i].t <= window && after.t - t <= window;
  }

  // Rotation at time t, or null with no samples.
  at(t) {
    const s = this.samples;
    if (!s.length) return null;
    if (t <= s[0].t) return s[0].q;
    if (t >= s[s.length - 1].t) return s[s.length - 1].q;
    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t <= t) lo = mid;
      else hi = mid;
    }
    return slerp(s[lo].q, s[hi].q, (t - s[lo].t) / (s[hi].t - s[lo].t));
  }
}

// Measures the camera delay: how long before a camera frame's stamped time it was really
// captured. With the head roughly still, the eye's direction in the world (the phone
// rotation at capture time applied to the eye's direction in the phone's frame) stays
// constant while the phone turns. The delay that keeps it steadiest is the camera delay.
const WINDOW = 3; // s of samples considered
const MAX_DELAY = 0.3; // s
const STEP = 0.005; // s
const MIN_SAMPLES = 20;
const MIN_TURN = (8 * Math.PI) / 180; // the phone must turn this much in the window

export class DelayEstimator {
  constructor() {
    this.samples = []; // { t, dir }: frame time, unit eye direction in the phone frame
    this.delay = null; // s, smoothed estimate
  }

  add(t, dir) {
    const l = Math.hypot(dir[0], dir[1], dir[2]);
    this.samples.push({ t, dir: [dir[0] / l, dir[1] / l, dir[2] / l] });
    while (this.samples.length && this.samples[0].t < t - WINDOW) this.samples.shift();
  }

  // Re-estimate from the recent samples and the phone rotation history (relative
  // rotations: rotAt(t) → {x,y,z,w}). Returns the smoothed delay (s), or null until known.
  update(rotAt) {
    const s = this.samples;
    if (s.length < MIN_SAMPLES) return this.delay;
    const q0 = rotAt(s[0].t);
    let turn = 0;
    for (const x of s) {
      const q = rotAt(x.t);
      const d = Math.abs(q0.x * q.x + q0.y * q.y + q0.z * q.z + q0.w * q.w);
      turn = Math.max(turn, 2 * Math.acos(Math.min(1, d)));
    }
    if (turn < MIN_TURN) return this.delay; // not enough rotation to tell delays apart
    let best = null;
    let bestSpread = Infinity;
    for (let d = 0; d <= MAX_DELAY + 1e-9; d += STEP) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const x of s) {
        const w = rotate(rotAt(x.t - d), x.dir);
        sx += w[0];
        sy += w[1];
        sz += w[2];
      }
      const spread = 1 - Math.hypot(sx, sy, sz) / s.length;
      if (spread < bestSpread) {
        bestSpread = spread;
        best = d;
      }
    }
    this.delay = this.delay === null ? best : this.delay + (best - this.delay) * 0.3;
    return this.delay;
  }
}
