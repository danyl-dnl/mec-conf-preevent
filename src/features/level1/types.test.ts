import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGrid, isLevel1State, isAnswerResult, isPuzzleList, isCompletionResult } from './types.ts';
const completion = { photo_uploaded: false, completed: false, completed_at: null };
const state = { ...completion, status: 'FIND_PARTNER', name: 'Name', participant_code: 'CODE', fragment_slot: 'A', assigned_grid: [['a', '']], mutual_verified: false, solved: false };
test('rectangular grids support variable dimensions, bounded string cells only', () => {
  for (const value of [[['a']], [['a', ''], ['', 'b']], [Array(10).fill('')]]) assert.ok(isGrid(value));
  for (const value of [null, [], [[]], ['a'], [[1]], [['a'], ['b', 'c']], [Array(11).fill('')], Array(11).fill(['']), [['x'.repeat(129)]]]) assert.equal(isGrid(value), false);
});
test('safe states preserve the assigned grid before and after solving', () => {
  assert.ok(isLevel1State(state));
  assert.ok(isLevel1State({ ...state, fragment_slot: 'B' }));
  assert.ok(isLevel1State({ ...state, status: 'READY_TO_SOLVE', mutual_verified: true }));
  assert.ok(isLevel1State({ ...state, status: 'SOLVED', solved: true, mutual_verified: true, solved_at: '2026-09-23T12:00:00Z' }));
  assert.ok(isLevel1State({ ...completion, status: 'NOT_PAIRED', name: 'Name', participant_code: 'CODE' }));
  assert.ok(isLevel1State({ ...completion, status: 'NO_PUZZLE', name: 'Name', participant_code: 'CODE', fragment_slot: 'A', mutual_verified: false, solved: false }));
});
test('reject secrets, identifiers, alternate grids, and inconsistent readiness', () => {
  for (const key of ['correct_answer', 'grid_b', 'grid_a', 'puzzle_id', 'pair_id', 'id', 'participant_id', 'auth_user_id']) {
    assert.equal(isLevel1State({ ...state, [key]: 'private' }), false);
  }
  for (const value of [null, {}, { ...state, status: 'READY_TO_SOLVE' }, { ...state, solved: true }, { ...state, fragment_slot: 'C' }, { ...state, assigned_grid: [[1]] }]) assert.equal(isLevel1State(value), false);
});
test('answer responses never include an answer or hint', () => {
  assert.ok(isAnswerResult({ status: 'INCORRECT' }));
  assert.ok(isAnswerResult({ status: 'SOLVED', solved_at: '2026-09-23T12:00:00Z' }));
  for (const value of [{ status: 'INCORRECT', hint: 'close' }, { status: 'SOLVED' }, { status: 'SOLVED', solved_at: 'bad' }, { status: 'INCORRECT', correct_answer: 'secret' }]) assert.equal(isAnswerResult(value), false);
});
test('admin list only accepts safe puzzle metadata', () => {
  const row = { puzzle_code: 'P1', grid_rows: 2, grid_columns: 4, assigned_pair_count: 0 };
  assert.ok(isPuzzleList([row]));
  assert.equal(isPuzzleList([{ ...row, correct_answer: 'secret' }]), false);
  assert.equal(isPuzzleList([{ ...row, grid_columns: 11 }]), false);
});

test('completion requires consistent safe pair-wide metadata', () => {
  const done = { ...state, status: 'COMPLETED', solved: true, solved_at: '2026-09-23T12:00:00Z',
    photo_uploaded: true, completed: true, completed_at: '2026-09-23T12:01:00Z' };
  assert.ok(isLevel1State(done));
  for (const value of [{ ...done, photo_uploaded: false }, { ...done, solved: false },
    { ...done, completed_at: null }, { ...done, status: 'SOLVED' }, { ...done, photo_public_id: 'internal' },
    { ...state, completed_at: '2026-09-23T12:00:00Z' }]) assert.equal(isLevel1State(value), false);
});

test('completion response is safe and timestamped', () => {
  const done = { status: 'COMPLETED', completed_at: '2026-09-23T12:00:00Z' };
  assert.ok(isCompletionResult(done));
  assert.equal(isCompletionResult({ ...done, upload_token: 'secret' }), false);
  assert.equal(isCompletionResult({ ...done, completed_at: null }), false);
});
