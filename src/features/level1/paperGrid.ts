// Keep the existing JSON string-grid contract; no database/RPC changes needed.
// Empty = '', shaded = '█', number = canonical decimal string from 1 to 25.
export const SHADED_CELL = '█';
export function isClueNumber(cell: string): boolean {
  return /^(?:[1-9]|1[0-9]|2[0-5])$/.test(cell);
}
export function isPaperGrid(grid: string[][]): boolean {
  return grid.length === 5 && grid.every(row => row.length === 5 &&
    row.every(cell => cell === '' || cell === SHADED_CELL || isClueNumber(cell)));
}

// Legacy number/blank grids also satisfy the cell alphabet, but do not use
// complementary shading. Every new generated fragment contains shaded cells.
export function isPaperFragment(grid: string[][]): boolean {
  return isPaperGrid(grid) && grid.some(row => row.includes(SHADED_CELL));
}
