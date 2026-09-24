import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomPairPlan, saveRandomPairs } from './randomPairs.ts';
test('random pairing uses everyone once, preserves input and leaves one person for odd counts', () => {
  for (const count of [0, 1, 2, 6, 47, 48]) {
    const people = Array.from({length: count}, (_, i) => ({ participant_code: `P${i}` }));
    const original = structuredClone(people);
    const result = randomPairPlan(people);
    assert.equal(result.pairs.length, Math.floor(count / 2));
    assert.equal(result.leftover !== null, count % 2 === 1);
    const all = [...result.pairs.flat(), ...(result.leftover ? [result.leftover] : [])];
    assert.deepEqual(all.map(p => p.participant_code).sort(), people.map(p => p.participant_code).sort());
    assert.deepEqual(people, original);
  }
});
test('duplicate participant IDs cannot be scheduled twice', () => {
  assert.throws(() => randomPairPlan([{participant_code:'P1'}, {participant_code:'P1'}]));
});
test('saves confirmed pairs sequentially and stops on uncertain results', async () => {
  const calls: number[] = [];
  const result = await saveRandomPairs([[1,2],[3,4],[5,6]], async a => {
    calls.push(a);
    if (a === 3) throw new Error('Network failure');
  });
  assert.deepEqual(calls, [1,3]);
  assert.deepEqual(result, {created: 1, complete: false});
  assert.deepEqual(await saveRandomPairs([[1,2],[3,4]], async () => {}), {created: 2, complete: true});
});
