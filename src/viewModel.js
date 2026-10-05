// Eye-first view model. Pure math (no Three.js) so it can be unit-tested under node.
//
// Everything starts from the eye:
//   1. Face tracking gives the eye's position in the SCREEN frame (eyeS): origin at the
//      screen center, +x screen right, +y screen up, +z out of the screen toward the viewer.
//   2. The motion sensors give the phone's rotation in the WORLD frame (q).
//   3. The eye is the anchor in the world (eyeW). The screen's world placement follows
//      from it: screen center = eyeW − q·eyeS, each corner = center + q·corner.
//   4. The image is the generalized perspective projection (Kooima, "Generalized
//      Perspective Projection") from eyeW through those world-space corners: every pixel
//      shows what lies along the ray from the eye through that pixel's physical spot.
//
// Vectors are [x, y, z] arrays; quaternions are {x, y, z, w}.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

export const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

// Rotate vector v by unit quaternion q.
export function rotate(q, v) {
  const u = [q.x, q.y, q.z];
  const t = cross(u, v).map((c) => 2 * c);
  const ut = cross(u, t);
  return [v[0] + q.w * t[0] + ut[0], v[1] + q.w * t[1] + ut[1], v[2] + q.w * t[2] + ut[2]];
}

// Where the screen is in the world, given the eye's world position (the anchor), the
// phone's rotation, and the eye's position in the screen frame.
// Returns the corners Kooima needs: pa lower-left, pb lower-right, pc upper-left.
export function screenInWorld(eyeW, q, eyeS, w, h) {
  const center = sub(eyeW, rotate(q, eyeS));
  const at = (x, y) => add(center, rotate(q, [x, y, 0]));
  return { center, pa: at(-w / 2, -h / 2), pb: at(w / 2, -h / 2), pc: at(-w / 2, h / 2) };
}

// Generalized perspective projection from eye pe through the screen corners.
// Returns frustum extents at the near plane and the screen basis (vr right, vu up,
// vn normal toward the eye). The camera sits at pe with orientation (vr, vu, vn).
export function generalizedPerspective(pa, pb, pc, pe, near) {
  const vr = normalize(sub(pb, pa));
  const vu = normalize(sub(pc, pa));
  const vn = normalize(cross(vr, vu));
  const va = sub(pa, pe);
  const vb = sub(pb, pe);
  const vc = sub(pc, pe);
  const d = -dot(va, vn); // distance from the eye to the screen plane
  const k = near / d;
  return {
    left: dot(vr, va) * k,
    right: dot(vr, vb) * k,
    bottom: dot(vu, va) * k,
    top: dot(vu, vc) * k,
    vr,
    vu,
    vn,
    d,
  };
}
