import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneEuroFilter, OutlierGate } from '../src/filters.js';

test('One Euro filter settles on a steady input', () => {
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
  f.filter(0, 0);
  let out = 0;
  for (let i = 1; i <= 120; i++) out = f.filter(1, i / 60); // 2 s at 60 fps
  assert.ok(Math.abs(out - 1) < 0.01, `got ${out}`);
});

const FPS = 24;

test('outlier gate keeps ordinary jitter and head motion', () => {
  const g = new OutlierGate();
  for (let i = 0; i < 48; i++) {
    const t = i / FPS;
    // Head drifting at 0.3 m/s with ±5 mm jitter.
    const p = { x: 0.3 * t + (i % 2 ? 0.005 : -0.005), y: 0, z: 0.35 };
    assert.ok(g.accept(p, t), `frame ${i} rejected`);
  }
});

test('outlier gate drops a single-frame spike', () => {
  const g = new OutlierGate();
  for (let i = 0; i < 10; i++) g.accept({ x: 0, y: 0, z: 0.35 }, i / FPS);
  assert.equal(g.accept({ x: 0, y: 0, z: 0.6 }, 10 / FPS), false); // depth read 25 cm off
  assert.ok(g.accept({ x: 0, y: 0, z: 0.35 }, 11 / FPS));
});

test('outlier gate accepts a real jump once it repeats', () => {
  const g = new OutlierGate();
  for (let i = 0; i < 10; i++) g.accept({ x: 0, y: 0, z: 0.35 }, i / FPS);
  const moved = { x: 0.2, y: 0, z: 0.35 };
  assert.equal(g.accept(moved, 10 / FPS), false);
  assert.equal(g.accept(moved, 11 / FPS), false);
  assert.ok(g.accept(moved, 12 / FPS)); // third agreeing frame: the head really is there
  assert.ok(g.accept({ x: 0.205, y: 0, z: 0.35 }, 13 / FPS));
});

test('outlier gate starts fresh after a gap', () => {
  const g = new OutlierGate();
  g.accept({ x: 0, y: 0, z: 0.35 }, 0);
  assert.ok(g.accept({ x: 0.3, y: 0.1, z: 0.5 }, 2)); // eyes were lost for 2 s
});
