import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { isProgress, isResetResult, type ProgressRow } from './progress';
import './level1.css';

interface SelectedPhoto {
  url: string;
  pairCode: string;
  members: string;
}

export default function AdminProgress() {
  const [rows, setRows] = useState<ProgressRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [selectedPhoto, setSelectedPhoto] = useState<SelectedPhoto | null>(null);
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
          <td>
            {row.photo_url ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '11px', color: '#39ff14' }}>Uploaded</span>
                <button
                  type="button"
                  onClick={() => setSelectedPhoto({
                    url: row.photo_url!,
                    pairCode: row.pair_code,
                    members: `${row.member_a_name ?? row.member_a_code ?? 'A'} & ${row.member_b_name ?? row.member_b_code ?? 'B'}`
                  })}
                  style={{
                    background: 'rgba(57, 255, 20, 0.1)',
                    border: '1px solid #39ff14',
                    color: '#39ff14',
                    fontFamily: 'inherit',
                    fontSize: '11px',
                    padding: '3px 8px',
                    cursor: 'pointer',
                    letterSpacing: '0.04em'
                  }}
                >
                  [ VIEW PHOTO ]
                </button>
              </div>
            ) : row.photo_uploaded ? (
              'Uploaded'
            ) : (
              '—'
            )}
          </td>
          <td>{row.completed ? 'Complete' : 'In progress'}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p>No pairs assigned.</p>)}

    {/* Photo Modal Dialog */}
    {selectedPhoto && (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Photo for ${selectedPhoto.pairCode}`}
        onClick={() => setSelectedPhoto(null)}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.88)',
          zIndex: 99999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          boxSizing: 'border-box'
        }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background: '#050905',
            border: '1px solid #39ff14',
            padding: '24px',
            maxWidth: '680px',
            width: '100%',
            boxSizing: 'border-box',
            boxShadow: '0 0 30px rgba(57, 255, 20, 0.2)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '11px', color: 'rgba(57, 255, 20, 0.6)', letterSpacing: '0.1em' }}>
                VERIFIED PAIR PHOTO // {selectedPhoto.pairCode}
              </div>
              <div style={{ fontSize: '15px', color: '#39ff14', fontWeight: 'bold' }}>
                {selectedPhoto.members}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedPhoto(null)}
              style={{
                background: 'transparent',
                border: '1px solid rgba(57, 255, 20, 0.5)',
                color: '#39ff14',
                fontFamily: 'inherit',
                fontSize: '12px',
                padding: '6px 12px',
                cursor: 'pointer'
              }}
            >
              [ CLOSE ✕ ]
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', background: '#000', border: '1px solid rgba(57, 255, 20, 0.2)', padding: '8px' }}>
            <img
              src={selectedPhoto.url}
              alt={`Pair ${selectedPhoto.pairCode} completion`}
              style={{
                maxWidth: '100%',
                maxHeight: '65vh',
                objectFit: 'contain',
                display: 'block'
              }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <a
              href={selectedPhoto.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: '#39ff14',
                fontSize: '11px',
                textDecoration: 'underline',
                letterSpacing: '0.05em'
              }}
            >
              [ OPEN FULL SIZE IMAGE ↗ ]
            </a>
            <button
              type="button"
              onClick={() => setSelectedPhoto(null)}
              style={{
                background: '#39ff14',
                border: 'none',
                color: '#050905',
                fontFamily: 'inherit',
                fontSize: '12px',
                fontWeight: 'bold',
                padding: '8px 16px',
                cursor: 'pointer'
              }}
            >
              DONE
            </button>
          </div>
        </div>
      </div>
    )}
  </section>;
}
