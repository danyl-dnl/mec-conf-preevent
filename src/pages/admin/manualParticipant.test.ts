import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manualParticipantPayload } from './manualParticipant.ts';
test('manual details use the existing roster payload with normalized email and no client-generated identity', () => {
  assert.deepEqual(manualParticipantPayload(' Ada Lovelace ', ' ADA@Example.com ', ' CSE '),
    [{ row_number: 1, name: 'Ada Lovelace', email: 'ada@example.com', branch: 'CSE' }]);
});
test('manual fields reject missing, malformed, control-character and overlong input', () => {
  for (const args of [[' ', 'ada@example.com', 'CSE'], ['Ada', '', 'CSE'], ['Ada', 'ada@example.com', ' '],
    ['Ada', 'not-email', 'CSE'], ['Ada', 'ada @example.com', 'CSE'], ['Ad\na', 'ada@example.com', 'CSE'],
    ['A'.repeat(101), 'ada@example.com', 'CSE'], ['Ada', 'ada@example.com', 'C'.repeat(51)]]) {
    assert.throws(() => manualParticipantPayload(...args as [string, string, string]));
  }
});
