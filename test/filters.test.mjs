import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneEuroFilter } from '../src/filters.js';

test('One Euro filter settles on a steady input', () => {
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
  f.filter(0, 0);
  let out = 0;
  for (let i = 1; i <= 120; i++) out = f.filter(1, i / 60); // 2 s at 60 fps
  assert.ok(Math.abs(out - 1) < 0.01, `got ${out}`);
});
