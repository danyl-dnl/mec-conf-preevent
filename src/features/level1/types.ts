export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isGrid(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return false;
  const width = Array.isArray(value[0]) ? value[0].length : 0;
  return width >= 1 && width <= 10 && value.every(row => Array.isArray(row) &&
    row.length === width && row.every(cell => typeof cell === 'string' && [...cell].length <= 128));
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every(key => allowed.includes(key));
}
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
export type Level1State = {
  status: 'NOT_PAIRED' | 'NO_PUZZLE' | 'FIND_PARTNER' | 'READY_TO_SOLVE' | 'SOLVED';
  participant_code: string;
  name: string;
  fragment_slot?: 'A' | 'B';
  assigned_grid?: string[][];
  mutual_verified?: boolean;
  solved?: boolean;
  solved_at?: string;
};
export function isLevel1State(value: unknown): value is Level1State {
  if (!isRecord(value) || !nonblank(value.name) || !nonblank(value.participant_code)) return false;
  const base = ['status', 'participant_code', 'name'];
  if (value.status === 'NOT_PAIRED') return keys(value, base);
  const paired = [...base, 'fragment_slot', 'mutual_verified', 'solved'];
  if (!['A', 'B'].includes(String(value.fragment_slot)) || typeof value.mutual_verified !== 'boolean' ||
      typeof value.solved !== 'boolean') return false;
  if (value.status === 'NO_PUZZLE') return keys(value, paired) && value.solved === false;
  if (!isGrid(value.assigned_grid)) return false;
  if (value.status === 'SOLVED') return keys(value, [...paired, 'assigned_grid', 'solved_at']) &&
    value.solved === true && timestamp(value.solved_at);
  return keys(value, [...paired, 'assigned_grid']) && value.solved === false &&
    ((value.status === 'READY_TO_SOLVE' && value.mutual_verified === true) ||
     (value.status === 'FIND_PARTNER' && value.mutual_verified === false));
}
export type AnswerResult = { status: 'INCORRECT' } | { status: 'SOLVED'; solved_at: string };
export function isAnswerResult(value: unknown): value is AnswerResult {
  return isRecord(value) && ((value.status === 'INCORRECT' && keys(value, ['status'])) ||
    (value.status === 'SOLVED' && keys(value, ['status', 'solved_at']) && timestamp(value.solved_at)));
}
export interface PuzzleMetadata { puzzle_code: string; grid_rows: number; grid_columns: number; assigned_pair_count: number }
export function isPuzzleList(value: unknown): value is PuzzleMetadata[] {
  return Array.isArray(value) && value.every(row => isRecord(row) &&
    keys(row, ['puzzle_code', 'grid_rows', 'grid_columns', 'assigned_pair_count']) && nonblank(row.puzzle_code) &&
    [row.grid_rows, row.grid_columns].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 10) &&
    typeof row.assigned_pair_count === 'number' && Number.isSafeInteger(row.assigned_pair_count) && row.assigned_pair_count >= 0);
}
