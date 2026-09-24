import type { RosterPayloadRow } from './rosterTypes';
export function manualParticipantPayload(name: string, email: string, branch: string): RosterPayloadRow[] {
  const row = { row_number: 1, name: name.trim(), email: email.trim().toLowerCase(), branch: branch.trim() };
  if (!row.name || !row.email || !row.branch) throw new Error('Name, email address and branch are required.');
  if (row.name.length > 100 || row.email.length > 255 || row.branch.length > 50) throw new Error('Participant details exceed the allowed length.');
  // eslint-disable-next-line no-control-regex -- Match the roster server’s rejection of embedded control characters.
  if (Object.values(row).some(value => typeof value === 'string' && /[\x00-\x1f]/.test(value))) throw new Error('Remove control characters from participant details.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) throw new Error('Enter a valid email address.');
  return [row];
}
