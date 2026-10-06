import * as THREE from 'three';

// A real-size room (meters, 1 virtual meter = 1 real meter): 15 × 15 ft, 8 ft high, centered
// on the viewer's starting position. The phone screen starts at the origin, facing the
// viewer (+z); "in front" is −z. The phone is held 4 ft above the floor.
// Objects are small shapes on thin poles, 2–5 ft high, evenly all around the viewer,
// 4–7 ft away.
const FT = 0.3048;
const ROOM = { x0: -7.5 * FT, x1: 7.5 * FT, y0: -4 * FT, y1: 4 * FT, z0: -7.5 * FT, z1: 7.5 * FT };
const GRID_STEP = 1 * FT;

function gridPlane(width, height, step, color, opacity) {
  const pts = [];
  for (let x = -width / 2; x <= width / 2 + 1e-6; x += step) pts.push(x, -height / 2, 0, x, height / 2, 0);
  for (let y = -height / 2; y <= height / 2 + 1e-6; y += step) pts.push(-width / 2, y, 0, width / 2, y, 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  return new THREE.LineSegments(geo, mat);
}

function surface(width, height, color) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 })
  );
  mesh.receiveShadow = true;
  return mesh;
}

// One inward-facing wall: a solid plane plus a 1 ft grid just in front of it.
function wall(width, height, color, gridColor, gridOpacity) {
  const g = new THREE.Group();
  g.add(surface(width, height, color));
  const grid = gridPlane(width, height, GRID_STEP, gridColor, gridOpacity);
  grid.position.z = 0.002;
  g.add(grid);
  return g;
}

function buildRoom() {
  const { x0, x1, y0, y1, z0, z1 } = ROOM;
  const w = x1 - x0, h = y1 - y0, d = z1 - z0;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const room = new THREE.Group();

  const floor = wall(w, d, 0x15182a, 0x5ec8ff, 0.85);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, y0, cz);
  room.add(floor);

  const ceiling = wall(w, d, 0x101220, 0x3a4470, 0.35);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(cx, y1, cz);
  room.add(ceiling);

  const back = wall(w, h, 0x1a1d33, 0x7a6cff, 0.5);
  back.position.set(cx, cy, z0);
  room.add(back);

  const front = wall(w, h, 0x1a1d33, 0x7a6cff, 0.35);
  front.rotation.y = Math.PI;
  front.position.set(cx, cy, z1);
  room.add(front);

  const left = wall(d, h, 0x181b2e, 0x3fd6a0, 0.45);
  left.rotation.y = Math.PI / 2;
  left.position.set(x0, cy, cz);
  room.add(left);

  const right = wall(d, h, 0x181b2e, 0xff8a5c, 0.45);
  right.rotation.y = -Math.PI / 2;
  right.position.set(x1, cy, cz);
  room.add(right);

  return room;
}

function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1, ...extra });
}

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Floor position at `azDeg` degrees from straight ahead (−z; positive = to the right) and
// `distFt` feet from the viewer's starting position.
function spot(azDeg, distFt) {
  const a = (azDeg * Math.PI) / 180;
  return { x: Math.sin(a) * distFt * FT, z: -Math.cos(a) * distFt * FT };
}

// A thin pole from the floor with `top` (a mesh centered on its own origin, about
// 2·radius tall) resting on it; the top of the shape is `topFt` above the floor.
const POLE_RADIUS = 0.012;
function onPole(azDeg, distFt, topFt, top, radius) {
  const g = new THREE.Group();
  const { x, z } = spot(azDeg, distFt);
  const len = topFt * FT - 2 * radius;
  const pole = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, len, 16), std(0x8890b0)));
  pole.position.set(x, ROOM.y0 + len / 2, z);
  g.add(pole);
  top.position.set(x, ROOM.y0 + len + radius, z);
  g.add(shadowed(top));
  return g;
}

// Small shapes, radius in meters (2–4 in).
const SHAPES = [
  (r, c) => new THREE.Mesh(new THREE.SphereGeometry(r, 32, 24), std(c, { metalness: 0.5, roughness: 0.25 })),
  (r, c) => new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), std(c, { flatShading: true })),
  (r, c) => new THREE.Mesh(new THREE.BoxGeometry(r * 1.4, r * 1.4, r * 1.4), std(c)),
  (r, c) => new THREE.Mesh(new THREE.TorusKnotGeometry(r * 0.6, r * 0.2, 128, 16), std(c, { metalness: 0.4 })),
  (r, c) => new THREE.Mesh(new THREE.ConeGeometry(r, r * 2, 24), std(c)),
  (r, c) => new THREE.Mesh(new THREE.OctahedronGeometry(r, 0), std(c, { flatShading: true })),
];
const COLORS = [0xffc94a, 0xff5d8f, 0x5ec8ff, 0x3fd6a0, 0xa98bff, 0xff8a5c];

// Objects evenly all around the starting position (one every 30°), each 4–7 ft away with
// its top 2–5 ft above the floor, so neighbors differ in distance and height.
//   [distance ft, top height ft, shape radius in]
const RING = [
  [4.0, 3.5, 3],
  [6.5, 4.5, 2.5],
  [5.0, 2.5, 3.5],
  [7.0, 5.0, 2],
  [4.5, 3.0, 2.5],
  [6.0, 4.0, 3],
  [5.5, 2.0, 4],
  [4.0, 4.5, 2],
  [6.5, 3.0, 3.5],
  [5.0, 5.0, 2.5],
  [7.0, 2.5, 3],
  [4.5, 4.0, 3.5],
];

function buildObjects() {
  const g = new THREE.Group();
  const INCH = FT / 12;
  RING.forEach(([dist, top, rIn], i) => {
    const r = rIn * INCH;
    const shape = SHAPES[i % SHAPES.length](r, COLORS[(i * 5) % COLORS.length]);
    shape.rotation.set(0.3 * i, 0.5 * i, 0);
    g.add(onPole(i * 30, dist, top, shape, r));
  });

  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.08, 24, 16), new THREE.MeshBasicMaterial({ color: 0xfff2c4 }));
  lamp.position.set(0, ROOM.y1 - 0.15, 0);
  g.add(lamp);

  return g;
}

const KEY_INTENSITY = 6;
const KEY_DECAY = 1.2;

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080f);
  scene.fog = new THREE.Fog(0x07080f, 6, 14); // distances from the camera; far corner ≈ 3.5 m

  const world = new THREE.Group(); // scaled by the "world scale" setting
  scene.add(world);
  world.add(buildRoom());
  world.add(buildObjects());

  world.add(new THREE.HemisphereLight(0xb8c4ff, 0x1a1420, 0.9));
  const key = new THREE.PointLight(0xfff2c4, KEY_INTENSITY, 0, KEY_DECAY);
  key.position.set(0, ROOM.y1 - 0.3, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.05;
  key.shadow.camera.far = 20;
  key.shadow.bias = -0.002;
  world.add(key);
  const fill = new THREE.DirectionalLight(0x8fb8ff, 0.6);
  fill.position.set(1, 2, 2);
  world.add(fill);

  // Uniformly resize the world (the user's World scale; 1 = real size). The point light
  // falls off with distance, so its intensity is compensated to keep brightness.
  function setWorldScale(userScale) {
    world.scale.setScalar(userScale);
    key.intensity = KEY_INTENSITY * Math.pow(userScale, KEY_DECAY);
  }

  return { scene, setWorldScale };
}
