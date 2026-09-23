import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProgress, isResetResult } from './progress.ts';
const row = { pair_code: 'PAIR-001', member_a_code: 'A', member_a_name: 'Alice', member_b_code: 'B', member_b_name: 'Bob',
  puzzle_code: 'GRID-01', a_verified: false, b_verified: true, mutual_verified: false, a_locked: true, b_locked: false,
  solved: false, photo_uploaded: false, completed: false, completed_at: null };
test('progress validates locked, pending and completed states', () => {
  assert.ok(isProgress([row]));
  assert.ok(isProgress([{ ...row, a_locked: false, a_verified: true, mutual_verified: true, solved: true,
    photo_uploaded: true, completed: true, completed_at: '2026-09-23T12:00:00Z' }]));
  for (const value of [{ ...row, a_locked: 'true' }, { ...row, completed: true }, { ...row, mutual_verified: true },
    { ...row, correct_answer: 'secret' }, { ...row, auth_user_id: 'uuid' }, { ...row, photo_public_id: 'private' }]) assert.equal(isProgress([value]), false);
});
test('reset response is scoped to the requested participant', () => {
  const reset = { success: true, participant_code: 'A', wrong_attempts: 0, is_locked: false, self_verified: false };
  assert.ok(isResetResult(reset, 'A'));
  assert.equal(isResetResult(reset, 'B'), false);
  assert.equal(isResetResult({ ...reset, is_locked: true }, 'A'), false);
});
