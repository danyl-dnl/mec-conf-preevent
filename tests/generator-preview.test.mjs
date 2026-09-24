import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import GeneratorPreview from '../src/features/level1/GeneratorPreview.tsx';
import PuzzleGrid from '../src/features/level1/PuzzleGrid.tsx';
import { combineGrids, generatePuzzle } from '../src/features/level1/generator.ts';
import { SHADED_CELL } from '../src/features/level1/paperGrid.ts';
test('admin preview renders encoding and an overlay computed from both fragments', () => {
  const puzzle = generatePuzzle('spider man');
  const {values} = combineGrids(puzzle.gridA, puzzle.gridB);
  const html = renderToStaticMarkup(createElement(GeneratorPreview, { puzzle }));
  assert.match(html, /KEYWORD:<\/strong> SPIDERMAN/);
  puzzle.encoding.forEach((value, i) => assert.ok(html.includes(`${puzzle.keyword[i]} → ${value}`)));
  assert.match(html, /Fragment A preview/);
  assert.match(html, /Fragment B preview/);
  assert.match(html, /Combined overlay preview/);
  assert.ok(html.includes(`SURVIVING VALUES:</strong> ${values.join(', ')}`));
  assert.ok(html.includes(`SURVIVING LETTERS:</strong> ${values.map(n => String.fromCharCode(64+n)).join(', ')}`));
  assert.match(html, /EXPECTED KEYWORD:<\/strong> SPIDERMAN/);
  assert.equal((html.match(/role="cell"/g) || []).length, 75);
  assert.doesNotMatch(html, /STEP/);
});
test('admin preview explicitly explains duplicate-letter collapse and unordered clues', () => {
  const html = renderToStaticMarkup(createElement(GeneratorPreview, { puzzle: generatePuzzle('BATMAN') }));
  assert.equal((html.match(/A → 1/g) || []).length, 2);
  assert.match(html, /Repeated letters share one clue value/);
  assert.match(html, /Order and repeat counts are not encoded/);
});
test('shaded, empty and numbered cells render distinctly, while legacy text still works', () => {
  const html = renderToStaticMarkup(createElement(PuzzleGrid, { grid: [[SHADED_CELL, '', '19', 'legacy text']], label: 'Example' }));
  assert.match(html, /level1-grid-shaded" aria-label="Shaded"/);
  assert.match(html, /level1-grid-empty" aria-label="Empty"/);
  assert.match(html, /level1-grid-number"><span>19<\/span>/);
  assert.match(html, /legacy text/);
  assert.equal((html.match(/role="cell"/g) || []).length, 4);
});
test('participant grid renderer renders only the supplied fragment', () => {
  const puzzle = generatePuzzle('SPIDERMAN');
  for (const [slot, grid] of [['A', puzzle.gridA], ['B', puzzle.gridB]]) {
    const html = renderToStaticMarkup(createElement(PuzzleGrid, { grid, label: `Fragment ${slot}` }));
    assert.equal((html.match(/role="cell"/g) || []).length, 25);
    assert.equal((html.match(/level1-grid-shaded/g) || []).length, grid.flat().filter(cell => cell === SHADED_CELL).length);
    assert.doesNotMatch(html, /SPIDERMAN|SURVIVING|KEYWORD|ENCODING|STEP|Combined/);
  }
});
test('mobile grid has fluid width, square cells and no fixed minimum width', () => {
  const css = readFileSync(new URL('../src/features/level1/level1.css', import.meta.url), 'utf8');
  assert.match(css, /\.level1-grid \{[^}]*width: 100%/);
  assert.match(css, /\.level1-grid-cell \{[^}]*aspect-ratio: 1; min-width: 0/);
  assert.match(css, /\.level1-grid-shaded \{[^}]*repeating-linear-gradient/);
  const html = renderToStaticMarkup(createElement(PuzzleGrid, {grid: generatePuzzle('SPIDERMAN').gridA, label: 'Mobile'}));
  assert.match(html, /repeat\(5, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(html, /min-width/);
});

test('manual participant form renders accessible required fields and a preview action', async () => {
  const { default: Form } = await import('../src/pages/admin/ManualParticipantForm.tsx');
  const html = renderToStaticMarkup(createElement(Form, { disabled: false, onPreview() {}, onEdit() {} }));
  assert.match(html, /Add participant manually/);
  assert.match(html, /Name<input/);
  assert.match(html, /Email address<input[^>]*type="email"/);
  assert.match(html, /Branch<input/);
  assert.match(html, /REVIEW PARTICIPANT/);
  assert.match(html, /Participant ID is generated automatically/);
  assert.equal((html.match(/required=""/g) || []).length, 3);
  const busy = renderToStaticMarkup(createElement(Form, { disabled: true, onPreview() {}, onEdit() {} }));
  assert.equal((busy.match(/disabled=""/g) || []).length, 4);
});

test('deletion confirmation identifies selected participants and never confirms during render', async () => {
  const { default: Dialog } = await import('../src/pages/admin/DeleteParticipantsDialog.tsx');
  let confirmed = false;
  const participants = [{participant_code:'TEST-1',name:'Example Name',registered_email:'example@example.com',branch:'CS',is_linked:false}];
  const html = renderToStaticMarkup(createElement(Dialog, {participants,busy:false,onCancel(){},onConfirm(){confirmed=true;}}));
  assert.match(html,/Delete this participant/);
  assert.match(html,/Example Name/);
  assert.match(html,/example@example.com/);
  assert.match(html,/CANCEL/);
  assert.match(html,/DELETE PARTICIPANT/);
  assert.match(html,/dissolve their pair/);
  assert.equal(confirmed,false);

  // When participant is paired, dialog shows the pair warning
  const pairedMap = new Map([['TEST-1','PAIR-001']]);
  const htmlPaired = renderToStaticMarkup(createElement(Dialog, {participants,pairedMap,busy:false,onCancel(){},onConfirm(){}}));
  assert.match(htmlPaired,/already paired in PAIR-001/);
  assert.match(htmlPaired,/PAIRED: PAIR-001/);
});

test('admin management renders access control form and administrators table', async () => {
  const { default: AdminManagement } = await import('../src/pages/admin/AdminManagement.tsx');
  const html = renderToStaticMarkup(createElement(AdminManagement));
  assert.match(html, /ADMINISTRATOR_ACCESS_CONTROL/);
  assert.match(html, /ADD NEW ADMINISTRATOR/);
  assert.match(html, /input-new-admin-email/);
  assert.match(html, /btn-add-admin/);
  assert.match(html, /\+ ADD ADMIN/);
  assert.match(html, /AUTHORIZED ADMINISTRATORS/);
  assert.match(html, /EMAIL/);
  assert.match(html, /STATUS/);
  assert.match(html, /ACTIONS/);
});
