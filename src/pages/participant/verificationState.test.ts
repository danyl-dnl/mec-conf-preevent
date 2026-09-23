import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore Node executes TypeScript directly for this test.
import { isPairState, isVerifyResult } from './verificationState.ts';

const paired = {
  status: 'PAIRED', name: 'Participant', participant_code: 'MCF-001',
  fragment_slot: 'A', wrong_attempts: 0, attempts_remaining: 2,
  is_locked: false, self_verified: false, partner_verified: false, mutual_verified: false,
};

test('accepts all supported participant states', () => {
  assert.ok(isPairState({ status: 'NOT_PAIRED', name: 'Participant', participant_code: 'MCF-001' }));
  assert.ok(isPairState(paired));
  assert.ok(isPairState({ ...paired, fragment_slot: 'B', wrong_attempts: 1, attempts_remaining: 1 }));
  assert.ok(isPairState({ ...paired, wrong_attempts: 2, attempts_remaining: 0, is_locked: true }));
  assert.ok(isPairState({ ...paired, self_verified: true }));
  assert.ok(isPairState({ ...paired, self_verified: true, partner_verified: true, mutual_verified: true }));
});

test('rejects malformed, inconsistent, and identity-leaking responses', () => {
  for (const value of [null, [], {}, { ...paired, attempts_remaining: '2' },
    { ...paired, wrong_attempts: -1 }, { ...paired, fragment_slot: 'C' },
    { ...paired, mutual_verified: true }, { ...paired, is_locked: true },
    { ...paired, partner_verified: 'false' }, { ...paired, id: 'uuid' },
    { ...paired, auth_user_id: 'uuid' }, { ...paired, partner_name: 'Secret' }]) {
    assert.equal(isPairState(value), false);
  }
});

test('validates verification results before allowing a success or retry', () => {
  assert.ok(isVerifyResult({ status: 'INCORRECT', self_verified: false, attempts_remaining: 1 }));
  assert.ok(isVerifyResult({ status: 'LOCKED', self_verified: false, attempts_remaining: 0 }));
  for (const mutual of [true, false]) {
    assert.ok(isVerifyResult({ status: 'VERIFIED', self_verified: true,
      partner_verified: mutual, mutual_verified: mutual, attempts_remaining: 2 }));
  }
  for (const value of [null, { status: 'VERIFIED' },
    { status: 'LOCKED', self_verified: false, attempts_remaining: 1 },
    { status: 'INCORRECT', self_verified: false, attempts_remaining: 0 },
    { status: 'VERIFIED', self_verified: true, partner_verified: false,
      mutual_verified: true, attempts_remaining: 2 }]) assert.equal(isVerifyResult(value), false);
});
