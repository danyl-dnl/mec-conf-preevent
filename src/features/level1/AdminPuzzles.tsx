import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { isGrid, isPuzzleList, isRecord, type PuzzleMetadata } from './types';
import './level1.css';

export default function AdminPuzzles() {
  const [puzzles, setPuzzles] = useState<PuzzleMetadata[]>([]);
  const [pairs, setPairs] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [gridA, setGridA] = useState('');
  const [gridB, setGridB] = useState('');
  const [answer, setAnswer] = useState('');
  const [pair, setPair] = useState('');
  const [puzzle, setPuzzle] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [puzzleResult, pairResult] = await Promise.all([
        supabase.rpc('admin_list_puzzles'), supabase.rpc('admin_list_pairs'),
      ]);
      if (puzzleResult.error || pairResult.error || !isPuzzleList(puzzleResult.data) ||
          !Array.isArray(pairResult.data) || !pairResult.data.every(row => isRecord(row) && typeof row.pair_code === 'string')) {
        throw new Error('Invalid list response');
      }
      setLoadError('');
      setPuzzles(puzzleResult.data);
      setPairs(pairResult.data.map(row => row.pair_code));
    } catch {
      setLoadError('Could not load puzzles and pairs. Refresh lists to try again.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- Load organizer metadata from the server on mount.
    void refresh();
  }, [refresh]);

  async function create() {
    if (inFlight.current) return;
    setMessage('');
    let a: unknown;
    let b: unknown;
    try {
      a = JSON.parse(gridA);
      b = JSON.parse(gridB);
    } catch {
      setMessage('Grid A and Grid B must be valid JSON.');
      return;
    }
    if (!isGrid(a) || !isGrid(b) || a.length !== b.length || a[0].length !== b[0].length) {
      setMessage('Use matching rectangular grids of 1–10 rows and columns, with string cells up to 128 characters.');
      return;
    }
    if (!code.trim() || !answer.trim()) {
      setMessage('Puzzle code and correct answer are required.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('admin_create_puzzle', {
        puzzle_code: code.trim(), grid_a: a, grid_b: b, correct_answer: answer,
      });
      if (error || !isRecord(data) || Object.keys(data).length !== 1 || data.puzzle_code !== code.trim()) {
        throw new Error('Creation not confirmed');
      }
      setCode(''); setGridA(''); setGridB(''); setAnswer('');
      setMessage(`Puzzle ${data.puzzle_code} created.`);
      setLoading(true);
      await refresh();
    } catch {
      setMessage('Puzzle creation could not be confirmed. Refresh lists before retrying; puzzle codes must be unique.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function assign() {
    if (inFlight.current || !pair || !puzzle || loading || loadError) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const { data, error } = await supabase.rpc('admin_assign_puzzle_to_pair', {
        target_pair_code: pair, target_puzzle_code: puzzle,
      });
      if (error || !isRecord(data) || Object.keys(data).length !== 2 || data.pair_code !== pair || data.puzzle_code !== puzzle) {
        throw new Error('Assignment not confirmed');
      }
      setMessage(`${puzzle} assigned to ${pair}.`);
      setLoading(true);
      await refresh();
    } catch {
      setMessage('Assignment could not be confirmed. Refresh lists and retry. A solved pair cannot change puzzles.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <section className="level1-section" aria-label="Level 1 puzzle configuration">
    <h2>LEVEL 1 PUZZLES</h2>
    <button type="button" disabled={busy || loading} onClick={() => { setLoading(true); void refresh(); }}>Refresh Lists</button>
    {loading && <p role="status">Loading puzzles and pairs...</p>}
    {loadError && <p role="alert">{loadError}</p>}
    <div className="level1-admin-forms">
      <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <h3>CREATE PUZZLE</h3>
        <label>Puzzle Code<input value={code} onChange={event => setCode(event.target.value)} maxLength={128} required disabled={busy} /></label>
        <label>Grid A<textarea value={gridA} onChange={event => setGridA(event.target.value)} rows={4} maxLength={80000} placeholder={'[["1","","3"],["","5",""],["7","","9"]]'} required disabled={busy} /></label>
        <label>Grid B<textarea value={gridB} onChange={event => setGridB(event.target.value)} rows={4} maxLength={80000} placeholder={'[["","2",""],["4","","6"],["","8",""]]'} required disabled={busy} /></label>
        <label>Correct Answer<input type="password" value={answer} onChange={event => setAnswer(event.target.value)} maxLength={1024} autoComplete="off" required disabled={busy} /></label>
        <button disabled={busy}>Create Puzzle</button>
      </form>
      <form onSubmit={event => { event.preventDefault(); void assign(); }}>
        <h3>ASSIGN PUZZLE</h3>
        <label>Pair<select value={pair} onChange={event => setPair(event.target.value)} disabled={busy || loading || !!loadError} required>
          <option value="">Select pair</option>{pairs.map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label>Puzzle<select value={puzzle} onChange={event => setPuzzle(event.target.value)} disabled={busy || loading || !!loadError} required>
          <option value="">Select puzzle</option>{puzzles.map(row => <option key={row.puzzle_code}>{row.puzzle_code}</option>)}
        </select></label>
        <button disabled={busy || loading || !!loadError || !pair || !puzzle}>Assign Puzzle</button>
        <p>Refresh lists after creating a pair. Assignment preserves partner verification.</p>
      </form>
    </div>
    {message && <p className="level1-message" role="status">{message}</p>}
    <h3>PUZZLE LIST</h3>
    {!loading && !loadError && (puzzles.length ? <ul>{puzzles.map(row => <li key={row.puzzle_code}>
      {row.puzzle_code} — {row.grid_rows} × {row.grid_columns} — {row.assigned_pair_count} assigned pairs
    </li>)}</ul> : <p>No puzzles configured.</p>)}
  </section>;
}
