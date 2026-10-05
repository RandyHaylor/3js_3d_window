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
