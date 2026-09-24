import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectedRosterRows, toggleRosterSelection } from './rosterSelection.ts';
const rows = ['A','B','C'].map(code => ({ participant_code: code, name: code, branch: 'CS', registered_email: `${code}@example.com`, is_linked: false }));
test('checkbox toggles selection without duplicates or mutating prior state', () => {
  const before = ['A'];
  assert.deepEqual(toggleRosterSelection(before,'B'), ['A','B']);
  assert.deepEqual(toggleRosterSelection(before,'A'), []);
  assert.deepEqual(before,['A']);
});
test('bulk deletion includes only selected rows currently shown, excluding stale IDs', () => {
  assert.deepEqual(selectedRosterRows(rows.slice(0,2), ['A','C','missing']).map(row => row.participant_code), ['A']);
  assert.deepEqual(selectedRosterRows(rows, rows.map(row => row.participant_code)),rows);
  assert.deepEqual(selectedRosterRows(rows, []),[]);
});
