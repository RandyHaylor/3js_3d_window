// One Euro filter (Casiez et al. 2012): low jitter when still, low lag when moving.

const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  // value, time in seconds
  filter(value, t) {
    if (this.t === null) {
      this.x = value;
      this.t = t;
      return value;
    }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const rawDx = (value - this.x) / dt;
    const aD = alpha(this.dCutoff, dt);
    this.dx = aD * rawDx + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = alpha(cutoff, dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
}

// Three filters for an {x,y,z} point.
export class Vec3Filter {
  constructor(xyOpts, zOpts = xyOpts) {
    this.fx = new OneEuroFilter(xyOpts);
    this.fy = new OneEuroFilter(xyOpts);
    this.fz = new OneEuroFilter(zOpts);
  }

  setParams(xyOpts, zOpts = xyOpts) {
    Object.assign(this.fx, xyOpts);
    Object.assign(this.fy, xyOpts);
    Object.assign(this.fz, zOpts);
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }

  filter(p, t) {
    return { x: this.fx.filter(p.x, t), y: this.fy.filter(p.y, t), z: this.fz.filter(p.z, t) };
  }
}

// Drops single bad face-tracking measurements. A point that jumps further from the last
// accepted one than a head can move in that time (NOISE plus MAX_SPEED·dt) is an outlier,
// unless CONFIRM outliers in a row agree with each other: then the head really moved
// there. After a gap longer than MAX_GAP the next point starts fresh.
const NOISE = 0.03; // m
const MAX_SPEED = 1.5; // m/s
const CONFIRM = 3;
const MAX_GAP = 0.5; // s
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class OutlierGate {
  constructor() {
    this.reset();
  }

  reset() {
    this.last = null;
    this.lastT = null;
    this.pending = [];
  }

  // p: {x, y, z} in meters, t in seconds. Returns true if p should be used.
  accept(p, t) {
    const fresh = this.last === null || t - this.lastT > MAX_GAP;
    if (fresh || dist(p, this.last) <= NOISE + MAX_SPEED * (t - this.lastT)) return this.take(p, t);
    const prev = this.pending[this.pending.length - 1];
    if (prev && dist(p, prev.p) > NOISE + MAX_SPEED * (t - prev.t)) this.pending = [];
    this.pending.push({ p, t });
    return this.pending.length >= CONFIRM ? this.take(p, t) : false;
  }

  take(p, t) {
    this.last = { x: p.x, y: p.y, z: p.z };
    this.lastT = t;
    this.pending = [];
    return true;
  }
}
