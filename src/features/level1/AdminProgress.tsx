import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { isProgress, isResetResult, type ProgressRow } from './progress';
import './level1.css';

export default function AdminProgress() {
  const [rows, setRows] = useState<ProgressRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const { data, error: rpcError } = await supabase.rpc('admin_level1_progress');
      if (rpcError || !isProgress(data)) throw new Error('Invalid progress response');
      setRows(data);
      setError('');
    } catch {
      setError('Could not load pair progress. Refresh to try again.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- Fetch the organizer's current pair progress.
    void refresh();
  }, [refresh]);
  async function reset(code: string, name: string | null) {
    if (inFlight.current || loading || error) return;
    if (!window.confirm(`Reset partner verification for ${name ?? code} (${code})? Only this participant will be reset.`)) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const { data, error: rpcError } = await supabase.rpc('admin_reset_partner_verification', { participant_code: code });
      if (rpcError || !isResetResult(data, code)) throw new Error('Reset not confirmed');
      setMessage(`Verification reset for ${code}.`);
    } catch {
      setMessage('Reset could not be confirmed. Check the refreshed progress before trying again.');
    } finally {
      setLoading(true);
      await refresh();
      inFlight.current = false;
      setBusy(false);
    }
  }
  return <section className="level1-section" aria-label="Level 1 progress">
    <h2>LEVEL 1 PROGRESS</h2>
    <button type="button" disabled={loading || busy} onClick={() => { setLoading(true); void refresh(); }}>REFRESH</button>
    {loading && <p role="status">Loading pair progress...</p>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!loading && !error && (rows.length ? <div style={{ overflowX: 'auto' }}>
      <table className="level1-progress-table">
        <thead><tr>{['PAIR', 'MEMBERS', 'PUZZLE', 'PARTNER CHECK', 'PUZZLE', 'PHOTO', 'STATUS'].map((title, i) => <th key={i}>{title}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.pair_code}>
          <td>{row.pair_code}</td>
          <td>
            <div>A: {row.member_a_name ?? '—'} ({row.member_a_code ?? '—'})</div>
            <div>B: {row.member_b_name ?? '—'} ({row.member_b_code ?? '—'})</div>
          </td>
          <td>{row.puzzle_code ?? '—'}</td>
          <td>
            <div>{row.mutual_verified ? 'Verified' : 'Waiting'}</div>
            <div>A: {row.a_locked ? 'Locked' : row.a_verified ? 'Verified' : 'Waiting'}</div>
            <div>B: {row.b_locked ? 'Locked' : row.b_verified ? 'Verified' : 'Waiting'}</div>
            {row.a_locked && row.member_a_code && <button type="button" disabled={busy} onClick={() => void reset(row.member_a_code!, row.member_a_name)}>RESET A</button>}
            {row.b_locked && row.member_b_code && <button type="button" disabled={busy} onClick={() => void reset(row.member_b_code!, row.member_b_name)}>RESET B</button>}
          </td>
          <td>{row.solved ? 'Solved' : '—'}</td>
          <td>{row.photo_uploaded ? 'Uploaded' : '—'}</td>
          <td>{row.completed ? 'Complete' : 'In progress'}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p>No pairs assigned.</p>)}
  </section>;
}
