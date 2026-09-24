import { isClueNumber, SHADED_CELL } from './paperGrid';
export default function PuzzleGrid({ grid, label }: { grid: string[][]; label: string }) {
  return <div className="level1-grid" role="table" aria-label={label}>
    {grid.map((row, r) => <div className="level1-grid-row" role="row" key={r}
      style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}>
      {row.map((cell, c) => {
        const shaded = cell === SHADED_CELL;
        const style = shaded ? 'shaded' : cell === '' ? 'empty' : isClueNumber(cell) ? 'number' : 'text';
        return <div role="cell" key={c} className={`level1-grid-cell level1-grid-${style}`}
          aria-label={shaded ? 'Shaded' : cell === '' ? 'Empty' : undefined}>
          {!shaded && <span>{cell || '\u00a0'}</span>}
        </div>;
      })}
    </div>)}
  </div>;
}
