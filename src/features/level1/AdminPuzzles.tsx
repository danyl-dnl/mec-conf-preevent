import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { isPuzzleList, isRecord, type PuzzleMetadata } from './types';
import { generatePuzzle, type GeneratedPuzzle } from './generator';
import GeneratorPreview from './GeneratorPreview';
import './level1.css';

export default function AdminPuzzles({ refreshToken = 0 }: { refreshToken?: number }) {
  const [bank, setBank] = useState<{ total: number; available: number; pending_pairs: number } | null>(null);
  const [puzzles, setPuzzles] = useState<PuzzleMetadata[]>([]);
  const [pairs, setPairs] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [keyword, setKeyword] = useState('');
  const [generated, setGenerated] = useState<GeneratedPuzzle | null>(null);
  const [pair, setPair] = useState('');
  const [puzzle, setPuzzle] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [puzzleResult, pairResult, bankResult] = await Promise.all([
        supabase.rpc('admin_list_puzzles'), supabase.rpc('admin_list_pairs'), supabase.rpc('admin_puzzle_bank_status'),
      ]);
      if (puzzleResult.error || pairResult.error || !isPuzzleList(puzzleResult.data) ||
          !Array.isArray(pairResult.data) || !pairResult.data.every(row => isRecord(row) && typeof row.pair_code === 'string')) {
        throw new Error('Invalid list response');
      }
      if (bankResult.error || !isRecord(bankResult.data) ||
          !['total', 'available', 'pending_pairs'].every(key => Number.isSafeInteger(bankResult.data[key]) && bankResult.data[key] >= 0)) {
        throw new Error('Invalid bank status');
      }
      setBank({ total: Number(bankResult.data.total), available: Number(bankResult.data.available), pending_pairs: Number(bankResult.data.pending_pairs) });
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
  }, [refresh, refreshToken]);

  async function create() {
    if (inFlight.current) return;
    setMessage('');
    if (!code.trim() || !generated) {
      setMessage('Enter a puzzle code and generate a preview before saving.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('admin_create_bank_puzzle', {
        puzzle_code: code.trim(), grid_a: generated.gridA, grid_b: generated.gridB, correct_answer: generated.keyword,
      });
      if (error || !isRecord(data) || Object.keys(data).length !== 1 || data.puzzle_code !== code.trim()) {
        throw new Error('Creation not confirmed');
      }
      setCode(''); setKeyword(''); setGenerated(null);
      setMessage(`Puzzle ${data.puzzle_code} created.`);
      setLoading(true);
      await refresh();
    } catch {
      setMessage('Puzzle creation could not be confirmed. Refresh lists before retrying; puzzle codes and bank keywords must be unique.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function assignPending() {
    if (inFlight.current || loading || loadError) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      const { data, error } = await supabase.rpc('admin_assign_pending_puzzles');
      if (error || !isRecord(data) || typeof data.assigned !== 'number' || !Number.isSafeInteger(data.assigned) || data.assigned < 0) throw new Error('Assignment not confirmed');
      setMessage(`${data.assigned} pending pairs received puzzles.`);
    } catch {
      setMessage('Could not confirm assignment. Check available puzzles and refresh before retrying.');
    } finally {
      await refresh(); inFlight.current = false; setBusy(false);
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
    {bank && <div>
      <p>Puzzle bank: {bank.total} total · {bank.available} unused · {bank.pending_pairs} pairs awaiting puzzles.</p>
      <p>New pairs automatically receive an unused puzzle. Saving a new puzzle adds it to the bank.</p>
      <button type="button" disabled={busy || loading || !!loadError || bank.pending_pairs === 0 || bank.available < bank.pending_pairs}
        onClick={() => { void assignPending(); }}>ASSIGN PUZZLES TO WAITING PAIRS</button>
      {bank.available < bank.pending_pairs && <p>Add {bank.pending_pairs - bank.available} more puzzles to cover all waiting pairs.</p>}
    </div>}
    <div className="level1-admin-forms">
      <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <h3>CREATE PUZZLE</h3>
        <label>Puzzle Code<input value={code} onChange={event => setCode(event.target.value)} maxLength={128} required disabled={busy} /></label>
        <label>Hidden keyword<input value={keyword} onChange={event => { setKeyword(event.target.value); setGenerated(null); setMessage(''); }} maxLength={128} autoComplete="off" required disabled={busy} /></label>
        <p>1–12 letters, A–Y only. Spaces are ignored; repeated letters are allowed. Z is unsupported.</p>
        <button type="button" disabled={busy} onClick={() => {
          setMessage('');
          try { setGenerated(generatePuzzle(keyword)); }
          catch (error) { setGenerated(null); setMessage(error instanceof Error ? error.message : 'Could not generate puzzle.'); }
        }}>GENERATE 5x5 PUZZLE</button>
        <p>Paper-style keyword discovery: compare matching cells and discard any position shaded on either fragment.
          Convert the surviving numbers using A=1 through Y=25. Repeated letters use one clue cell;
          these clues do not specify letter order or repeat counts.</p>
        {generated && <GeneratorPreview puzzle={generated} />}
        <button disabled={busy || !generated}>Save Puzzle</button>
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
