import { isPaperGrid, SHADED_CELL } from './paperGrid.ts';
// Admin-only authoring data. Persist only grids and keyword through admin_create_puzzle.
export const MAX_KEYWORD_LENGTH = 12;
export function normalizeKeyword(input: string): string {
  const compact = input.replace(/\s/g, '');
  // Check before uppercasing so Unicode expansions cannot become accepted letters.
  if (/[zZ]/.test(compact)) throw new Error('Z is not supported: 26 cannot fit in a 1–25 grid.');
  if (!/^[a-yA-Y]+$/.test(compact)) throw new Error('Use letters A–Y only; spaces are ignored.');
  if (compact.length > MAX_KEYWORD_LENGTH) throw new Error(`Use at most ${MAX_KEYWORD_LENGTH} letters.`);
  return compact.toUpperCase();
}
export function keywordPositions(input: string): number[] {
  return [...normalizeKeyword(input)].map(letter => letter.charCodeAt(0) - 64);
}
export interface GeneratedPuzzle { keyword: string; encoding: number[]; gridA: string[][]; gridB: string[][] }
function shuffle<T>(values: T[]): T[] {
  for (let i = values.length - 1; i > 0; i--) {
    // Rejection sampling avoids modulo bias.
    const limit = Math.floor(0x100000000 / (i + 1)) * (i + 1);
    let value: number;
    do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= limit);
    const j = value % (i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
// Balance each category independently; randomly choose who gets the extra cell.
function balancedOwners(count: number): boolean[] {
  const extra = crypto.getRandomValues(new Uint8Array(1))[0] % 2;
  const aCount = Math.floor(count / 2) + (count % 2 ? extra : 0);
  return shuffle(Array.from({ length: count }, (_, i) => i < aCount));
}
export function generatePuzzle(input: string): GeneratedPuzzle {
  const keyword = normalizeKeyword(input);
  const encoding = keywordPositions(keyword);
  const clues = shuffle([...new Set(encoding)]);
  const positions = shuffle(Array.from({ length: 25 }, (_, i) => i));
  const clueOwners = balancedOwners(clues.length);
  const shadeOwners = balancedOwners(25 - clues.length);
  const gridA = Array.from({ length: 5 }, () => Array<string>(5).fill(''));
  const gridB = Array.from({ length: 5 }, () => Array<string>(5).fill(''));
  positions.forEach((position, index) => {
    const clue = index < clues.length;
    const ownedByA = clue ? clueOwners[index] : shadeOwners[index - clues.length];
    const grid = ownedByA ? gridA : gridB;
    grid[Math.floor(position / 5)][position % 5] = clue ? String(clues[index]) : SHADED_CELL;
    // The opposite fragment remains empty at this coordinate in both cases.
  });
  return { keyword, encoding, gridA, gridB };
}

// Admin-only overlay. The output is a spatial clue set, NOT an ordered answer.
// Validate the two allowed pair states so a malformed puzzle cannot get a
// misleading successful preview. No keyword/answer is used to compute it.
export function combineGrids(gridA: string[][], gridB: string[][]): { grid: string[][]; values: number[] } {
  if (!isPaperGrid(gridA) || !isPaperGrid(gridB)) throw new Error('Expected two paper-style 5×5 grids.');
  const values: number[] = [];
  const grid = gridA.map((row, r) => row.map((a, c) => {
    const b = gridB[r][c];
    if ((a === '') === (b === '')) throw new Error('Each coordinate must have exactly one empty side.');
    if (a === SHADED_CELL || b === SHADED_CELL) return '';
    const number = a || b;
    values.push(Number(number));
    return number;
  }));
  if (new Set(values).size !== values.length) throw new Error('Paper clues must use unique alphabet values.');
  return { grid, values };
}
