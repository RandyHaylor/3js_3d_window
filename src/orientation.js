import * as THREE from 'three';
import { RotationHistory } from './timeline.js';

// Device orientation → quaternion, using the same convention as three.js's former
// DeviceOrientationControls: the resulting frame looks out of the back of the phone
// along -Z, with +Y toward the top of the screen.

const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° about X

const DEG = Math.PI / 180;
const tmp = new THREE.Quaternion();

// When an event was measured, in seconds on the performance.now() timeline. Event
// timestamps use that timeline in current browsers; if one doesn't (e.g. epoch time), the
// arrival time stands in.
export function eventTime(e) {
  const now = performance.now();
  const ts = e.timeStamp;
  return (typeof ts === 'number' && ts > 0 && ts <= now + 1 && now - ts < 1000 ? ts : now) / 1000;
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

// Asks for motion-sensor access (rotation and acceleration). Must be called
// synchronously from a user gesture on iOS.
export function requestOrientationPermission() {
  const ask = (E) =>
    E && typeof E.requestPermission === 'function'
      ? E.requestPermission().catch(() => 'denied')
      : Promise.resolve(E ? 'granted' : 'unsupported');
  return Promise.all([ask(window.DeviceOrientationEvent), ask(window.DeviceMotionEvent)]).then(([o, m]) =>
    o === 'granted' && m === 'granted' ? 'granted' : `orientation ${o}, motion ${m}`
  );
}

export class OrientationTracker {
  constructor() {
    this.current = new THREE.Quaternion();
    this.reference = null;
    this.hasData = false;
    this.history = new RotationHistory(); // `current` over time, stamped when measured
    this._onEvent = (e) => {
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      euler.set((e.beta || 0) * DEG, (e.alpha || 0) * DEG, -(e.gamma || 0) * DEG, 'YXZ');
      this.current.setFromEuler(euler);
      this.current.multiply(q1);
      this.current.multiply(q0.setFromAxisAngle(zee, -screenAngle() * DEG));
      this.history.push(eventTime(e), this.current);
      if (!this.hasData) {
        this.hasData = true;
        if (!this.reference) this.center(); // provisional until the user taps Center
      }
    };
  }

  start() {
    window.addEventListener('deviceorientation', this._onEvent);
  }

  center() {
    this.reference = this.current.clone();
  }

  // Rotation of the phone relative to the Center pose. Writes into out.
  relative(out) {
    if (!this.hasData || !this.reference) return out.identity();
    return out.copy(this.reference).invert().multiply(this.current);
  }

  // The same, at time t (seconds, performance.now() timeline), interpolated from the
  // timestamped history. Writes into out.
  relativeAt(t, out) {
    const q = this.history.at(t);
    if (!q || !this.reference) return this.relative(out);
    return out.copy(this.reference).invert().multiply(tmp.set(q.x, q.y, q.z, q.w));
  }
}
