import type { AdminParticipantRow } from './rosterTypes';
export function selectedRosterRows(rows: AdminParticipantRow[], selected: readonly string[]) {
  const codes = new Set(selected);
  return rows.filter(row => codes.has(row.participant_code));
}
export function toggleRosterSelection(selected: readonly string[], code: string) {
  return selected.includes(code) ? selected.filter(value => value !== code) : [...selected, code];
}
