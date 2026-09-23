import { isRecord } from './types.ts';
export interface ProgressRow {
  pair_code: string;
  member_a_code: string | null;
  member_a_name: string | null;
  member_b_code: string | null;
  member_b_name: string | null;
  puzzle_code: string | null;
  a_verified: boolean;
  b_verified: boolean;
  mutual_verified: boolean;
  a_locked: boolean;
  b_locked: boolean;
  solved: boolean;
  photo_uploaded: boolean;
  completed: boolean;
  completed_at: string | null;
}
const nullableText = ['member_a_code', 'member_a_name', 'member_b_code', 'member_b_name', 'puzzle_code'];
const booleans = ['a_verified', 'b_verified', 'mutual_verified', 'a_locked', 'b_locked', 'solved', 'photo_uploaded', 'completed'];
export function isProgress(value: unknown): value is ProgressRow[] {
  return Array.isArray(value) && value.every(row => isRecord(row) &&
    Object.keys(row).every(key => ['pair_code', 'completed_at', ...nullableText, ...booleans].includes(key)) &&
    typeof row.pair_code === 'string' && row.pair_code.length > 0 &&
    nullableText.every(key => row[key] === null || typeof row[key] === 'string') &&
    booleans.every(key => typeof row[key] === 'boolean') &&
    row.mutual_verified === (row.a_verified && row.b_verified) &&
    row.photo_uploaded === row.completed &&
    (row.completed ? row.solved === true && typeof row.completed_at === 'string' && Number.isFinite(Date.parse(row.completed_at)) : row.completed_at === null));
}
export function isResetResult(value: unknown, code: string): boolean {
  return isRecord(value) && Object.keys(value).every(key => ['success', 'participant_code', 'wrong_attempts', 'is_locked', 'self_verified'].includes(key)) &&
    value.success === true && value.participant_code === code && value.wrong_attempts === 0 && value.is_locked === false && value.self_verified === false;
}
