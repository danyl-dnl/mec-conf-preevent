import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineGrids, generatePuzzle, keywordPositions, normalizeKeyword } from './generator.ts';
import { isClueNumber, isPaperGrid, isPaperFragment, SHADED_CELL } from './paperGrid.ts';
import { isGrid, isLevel1State } from './types.ts';
const sorted = (values: number[]) => values.toSorted((a, b) => a - b);

test('SPIDERMAN encoding and normalization', () => {
  assert.deepEqual(keywordPositions('SPIDERMAN'), [19,16,9,4,5,18,13,1,14]);
  assert.equal(normalizeKeyword(' spider man '), 'SPIDERMAN');
  assert.deepEqual(keywordPositions('spiderman'), keywordPositions('SPIDERMAN'));
});
test('BATMAN keeps repeated A in admin encoding but has one A clue', () => {
  const puzzle = generatePuzzle('BATMAN');
  assert.deepEqual(puzzle.encoding, [2,1,20,13,1,14]);
  assert.deepEqual(sorted(combineGrids(puzzle.gridA, puzzle.gridB).values), [1,2,13,14,20]);
});
test('reject Z, unsupported characters, empty or overlong keywords', () => {
  for (const word of ['Z', 'zebra', 'A1', 'A-B', 'A_B', 'é', 'ß', '', '   ', 'A'.repeat(13)]) {
    assert.throws(() => generatePuzzle(word));
  }
});
test('paper invariants and exact clue sets across multiple keywords and randomized layouts', () => {
  for (const word of ['SPIDERMAN', 'BATMAN', 'BANANA', 'A', 'A'.repeat(12), 'ABABABABABAB', 'ABCDEFGHIJKL', 'MNOPQRSTUVW', 'XY']) {
    for (let run = 0; run < 50; run++) {
      const result = generatePuzzle(word);
      const expected = sorted([...new Set(keywordPositions(word))]);
      const a = result.gridA.flat(), b = result.gridB.flat();
      for (const grid of [result.gridA, result.gridB]) {
        assert.ok(isGrid(grid)); // Existing database/participant JSON contract.
        assert.ok(isPaperGrid(grid));
        assert.equal(grid.length, 5);
        grid.forEach(row => assert.equal(row.length, 5));
        assert.ok(grid.flat().filter(isClueNumber).length <= 6);
        assert.ok(grid.flat().filter(cell => cell === '' || cell === SHADED_CELL).length >= 19);
        assert.doesNotMatch(JSON.stringify(grid), /STEP|sequence|keyword|encoding/);
      }
      let clueCount = 0, normalCount = 0;
      a.forEach((cell, i) => {
        if (isClueNumber(cell) || isClueNumber(b[i])) {
          clueCount++;
          assert.ok((isClueNumber(cell) && b[i] === '') || (cell === '' && isClueNumber(b[i])));
        } else {
          normalCount++;
          assert.ok((cell === SHADED_CELL && b[i] === '') || (cell === '' && b[i] === SHADED_CELL));
        }
      });
      assert.equal(clueCount, expected.length);
      assert.equal(normalCount, 25 - expected.length);
      for (const predicate of [isClueNumber, (cell: string) => cell === SHADED_CELL]) {
        assert.ok(Math.abs(a.filter(predicate).length - b.filter(predicate).length) <= 1);
      }
      const combined = combineGrids(result.gridA, result.gridB);
      assert.deepEqual(sorted(combined.values), expected); // No extras, duplicates, or missing clues.
      assert.deepEqual(combined.grid.flat().filter(isClueNumber).map(Number), combined.values);
      assert.ok(combined.grid.flat().every(cell => cell === '' || isClueNumber(cell)));
      assert.deepEqual(combineGrids(result.gridB, result.gridA), combined);
    }
  }
});
test('combine derives survivors from actual coordinates without consulting an answer', () => {
  const a = Array.from({length: 5}, () => Array<string>(5).fill(SHADED_CELL));
  const b = Array.from({length: 5}, () => Array<string>(5).fill(''));
  a[0][0] = '19'; a[2][3] = ''; b[2][3] = '16';
  a[4][4] = ''; b[4][4] = SHADED_CELL;
  const combined = combineGrids(a, b);
  assert.deepEqual(combined.values, [19,16]);
  assert.equal(combined.grid[0][0], '19');
  assert.equal(combined.grid[2][3], '16');
  assert.equal(combined.grid[4][4], '');
});
test('combine rejects forbidden pair states, invalid numbers and duplicate values', () => {
  for (const pair of [[SHADED_CELL,SHADED_CELL], ['1','2'], ['1',SHADED_CELL], [SHADED_CELL,'1'], ['',''], ['26',''], ['0',''], ['01','']]) {
    const a = Array.from({length: 5}, () => Array<string>(5).fill(SHADED_CELL));
    const b = Array.from({length: 5}, () => Array<string>(5).fill(''));
    [a[0][0], b[0][0]] = pair;
    assert.throws(() => combineGrids(a, b));
  }
  assert.throws(() => combineGrids([['1']], [['']]));
  const a = Array.from({length: 5}, () => Array<string>(5).fill(SHADED_CELL));
  const b = Array.from({length: 5}, () => Array<string>(5).fill(''));
  a[0][0] = '1'; a[0][1] = '1';
  assert.throws(() => combineGrids(a, b));
});
test('participant state refuses admin overlay, answer and alternate fragment', () => {
  const generated = generatePuzzle('SPIDERMAN');
  const state = { status: 'FIND_PARTNER', name: 'Name', participant_code: 'P', fragment_slot: 'A',
    assigned_grid: generated.gridA, mutual_verified: false, solved: false,
    photo_uploaded: false, completed: false, completed_at: null };
  assert.ok(isLevel1State(state));
  for (const key of ['keyword', 'encoding', 'sequence', 'answer_sequence', 'correct_answer', 'grid_b', 'grid_a', 'combined', 'surviving_values']) {
    assert.equal(isLevel1State({ ...state, [key]: generated }), false);
  }
});

test('legacy odd/even fixtures do not receive paper-shading instructions', () => {
  for (const parity of [0, 1]) {
    const legacy = Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => {
      const number = r * 5 + c + 1;
      return number % 2 === parity ? String(number) : '';
    }));
    assert.ok(isPaperGrid(legacy));
    assert.equal(isPaperFragment(legacy), false);
  }
  for (const word of ['SPIDERMAN', 'BATMAN', 'A', 'ABCDEFGHIJKL']) {
    const { gridA, gridB } = generatePuzzle(word);
    assert.ok(isPaperFragment(gridA));
    assert.ok(isPaperFragment(gridB));
  }
});
