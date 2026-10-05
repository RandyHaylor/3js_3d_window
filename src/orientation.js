import * as THREE from 'three';

// Device orientation → quaternion, using the same convention as three.js's former
// DeviceOrientationControls: the resulting frame looks out of the back of the phone
// along -Z, with +Y toward the top of the screen.

const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° about X

const DEG = Math.PI / 180;

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

// Must be called synchronously from a user gesture on iOS.
export function requestOrientationPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    return DOE.requestPermission().catch(() => 'denied');
  }
  return Promise.resolve(DOE ? 'granted' : 'unsupported');
}

export class OrientationTracker {
  constructor() {
    this.current = new THREE.Quaternion();
    this.reference = null;
    this.hasData = false;
    this._onEvent = (e) => {
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      euler.set((e.beta || 0) * DEG, (e.alpha || 0) * DEG, -(e.gamma || 0) * DEG, 'YXZ');
      this.current.setFromEuler(euler);
      this.current.multiply(q1);
      this.current.multiply(q0.setFromAxisAngle(zee, -screenAngle() * DEG));
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
}
