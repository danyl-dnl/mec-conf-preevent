import { combineGrids, type GeneratedPuzzle } from './generator';
import PuzzleGrid from './PuzzleGrid';
export default function GeneratorPreview({ puzzle }: { puzzle: GeneratedPuzzle }) {
  const combined = combineGrids(puzzle.gridA, puzzle.gridB);
  return <section className="level1-generator-preview" aria-label="Admin generator preview">
    <p><strong>KEYWORD:</strong> {puzzle.keyword}</p>
    <h3>ENCODING</h3>
    <ul>{puzzle.encoding.map((value, index) => <li key={index}>{puzzle.keyword[index]} → {value}</li>)}</ul>
    <p>Repeated letters share one clue value. Order and repeat counts are not encoded; find the keyword from the letter set.</p>
    <h3>FRAGMENT A</h3><PuzzleGrid grid={puzzle.gridA} label="Fragment A preview" />
    <h3>FRAGMENT B</h3><PuzzleGrid grid={puzzle.gridB} label="Fragment B preview" />
    <h3>COMBINED / OVERLAY PREVIEW</h3><PuzzleGrid grid={combined.grid} label="Combined overlay preview" />
    <p><strong>SURVIVING VALUES:</strong> {combined.values.join(', ')}</p>
    <p><strong>SURVIVING LETTERS:</strong> {combined.values.map(value => String.fromCharCode(64 + value)).join(', ')}</p>
    <p>Survivors are listed in grid reading order, not keyword order.</p>
    <p><strong>EXPECTED KEYWORD:</strong> {puzzle.keyword}</p>
  </section>;
}
