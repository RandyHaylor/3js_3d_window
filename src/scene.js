import * as THREE from 'three';

// A fixed diorama-scale room (meters). The phone screen sits at the origin in the
// z=0 plane; most of the room lies behind it (-z) but it also wraps around the
// viewer so rotating the phone reveals the side walls.
const ROOM = { x0: -0.4, x1: 0.4, y0: -0.4, y1: 0.28, z0: -1.0, z1: 0.6 };
// The room and everything in it is built at the sizes below and then scaled up so the
// back wall sits 6 ft (1.83 m) behind the screen. 1 virtual meter = 1 real meter after this.
const SCENE_SCALE = 1.83;
// Height the objects are arranged on. Kept above the floor so the floor sits well
// below the screen's lower edge while the objects stay in view.
const BASE_Y = -0.16;
const GRID_STEP = 0.05;

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

// One inward-facing wall: a solid plane plus grid lines just in front of it.
function wall(width, height, color, gridColor, gridOpacity) {
  const g = new THREE.Group();
  g.add(surface(width, height, color));
  const grid = gridPlane(width, height, GRID_STEP, gridColor, gridOpacity);
  grid.position.z = 0.0008;
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

  const front = wall(w, h, 0x1a1d33, 0x7a6cff, 0.3);
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

// A stand rising from the floor to `height` above BASE_Y.
function pedestal(x, z, height, radius, color) {
  const top = BASE_Y + height;
  const len = top - ROOM.y0;
  const m = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.1, len, 32), std(color)));
  m.position.set(x, ROOM.y0 + len / 2, z);
  return m;
}

function buildObjects() {
  const g = new THREE.Group();
  const floorY = BASE_Y;

  // Foreground: a torus knot just behind the glass, on a slim stand.
  const fgStandH = 0.13;
  g.add(pedestal(0.012, -0.07, fgStandH, 0.006, 0x8890b0));
  const knot = shadowed(new THREE.Mesh(new THREE.TorusKnotGeometry(0.018, 0.0055, 160, 24), std(0xffc94a, { metalness: 0.4 })));
  knot.position.set(0.012, floorY + fgStandH + 0.024, -0.07);
  knot.rotation.set(0.4, 0.6, 0);
  g.add(knot);

  // Mid-ground: columns of varying height and a sphere, staggered for occlusion.
  const mids = [
    [-0.09, -0.24, 0.16, 0xff5d8f],
    [0.07, -0.32, 0.22, 0x5ec8ff],
    [-0.02, -0.42, 0.11, 0x3fd6a0],
  ];
  for (const [x, z, hgt, c] of mids) {
    g.add(pedestal(x, z, hgt, 0.022, c));
    const cap = shadowed(new THREE.Mesh(new THREE.IcosahedronGeometry(0.02, 0), std(0xffffff, { flatShading: true })));
    cap.position.set(x, floorY + hgt + 0.03, z);
    g.add(cap);
  }
  const ball = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.035, 48, 32), std(0xa98bff, { metalness: 0.6, roughness: 0.2 })));
  ball.position.set(0.13, floorY + 0.035, -0.18);
  g.add(ball);

  // Far: a large ring on the back wall plus a row of cubes.
  const ring = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.015, 24, 96), std(0xff8a5c, { emissive: 0x401808 })));
  ring.position.set(0, floorY + 0.24, ROOM.z0 + 0.06);
  g.add(ring);
  for (let i = 0; i < 7; i++) {
    const s = 0.04;
    const cube = shadowed(new THREE.Mesh(new THREE.BoxGeometry(s, s, s), std(new THREE.Color().setHSL(i / 7, 0.7, 0.55))));
    cube.position.set(-0.27 + i * 0.09, floorY + s / 2, -0.78);
    cube.rotation.y = i * 0.3;
    g.add(cube);
  }

  // Off to the sides, found by turning the phone.
  const leftCone = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 32), std(0x3fd6a0)));
  leftCone.position.set(-0.3, floorY + 0.08, -0.05);
  g.add(leftCone);
  const rightBox = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.08), std(0xff5d8f)));
  rightBox.position.set(0.3, floorY + 0.1, 0.0);
  rightBox.rotation.y = 0.5;
  g.add(rightBox);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.025, 24, 16), new THREE.MeshBasicMaterial({ color: 0xfff2c4 }));
  lamp.position.set(0, ROOM.y1 - 0.04, -0.35);
  g.add(lamp);

  return g;
}

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080f);
  scene.fog = new THREE.Fog(0x07080f, 2.5, 6); // distances from the eye; back wall ≈ 2.2 m

  const world = new THREE.Group(); // scaled by the "world scale" setting
  scene.add(world);
  world.add(buildRoom());
  world.add(buildObjects());

  world.add(new THREE.HemisphereLight(0xb8c4ff, 0x1a1420, 0.9));
  const key = new THREE.PointLight(0xfff2c4, 1.6, 0, 1.2);
  key.position.set(0, ROOM.y1 - 0.08, -0.35);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.01;
  key.shadow.camera.far = 8;
  key.shadow.bias = -0.002;
  world.add(key);
  const fill = new THREE.DirectionalLight(0x8fb8ff, 0.6);
  fill.position.set(0.3, 0.5, 0.5);
  world.add(fill);

  // Uniformly resize the world (the user's World scale on top of SCENE_SCALE). The point
  // light falls off with distance, so its intensity is compensated to keep brightness.
  function setWorldScale(userScale) {
    const s = userScale * SCENE_SCALE;
    world.scale.setScalar(s);
    key.intensity = 1.6 * Math.pow(s, 1.2);
  }

  return { scene, setWorldScale };
}
