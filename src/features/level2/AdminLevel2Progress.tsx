import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import './level2.css';

interface Level2ProgressRow {
  pair_code: string;
  level2_started_at: string;
  level2_completed_at: string | null;
  level2_current_index: number;
  completion_time_seconds: number | null;
}

export default function AdminLevel2Progress() {
  const [data, setData] = useState<Level2ProgressRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data: res, error: rpcError } = await supabase.rpc('admin_list_level2_progress');
      if (rpcError) throw rpcError;
      setData(res as Level2ProgressRow[]);
      setError(null);
    } catch {
      setError('Could not load Level 2 progress.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 10000); // Poll every 10s
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <section className="level2-section" aria-label="Level 2 Progress">
      <h2>LEVEL 2 PROGRESS</h2>
      
      {loading && <p role="status">Loading progress...</p>}
      {error && <p role="alert" style={{ color: 'red' }}>{error}</p>}
      
      {!loading && data && data.length === 0 && (
        <p>No pairs have started Level 2 yet.</p>
      )}

      {!loading && data && data.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', marginTop: '1rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--green)', color: 'var(--green-dim)' }}>
              <th style={{ padding: '0.5rem' }}>RANK</th>
              <th style={{ padding: '0.5rem' }}>PAIR CODE</th>
              <th style={{ padding: '0.5rem' }}>PROGRESS</th>
              <th style={{ padding: '0.5rem' }}>COMPLETED AT</th>
              <th style={{ padding: '0.5rem' }}>TIME</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, idx) => (
              <tr key={row.pair_code} style={{ borderBottom: '1px solid var(--green-faint)' }}>
                <td style={{ padding: '0.5rem' }}>
                  {row.level2_completed_at ? `#${idx + 1}` : '-'}
                </td>
                <td style={{ padding: '0.5rem', fontWeight: 'bold' }}>{row.pair_code}</td>
                <td style={{ padding: '0.5rem' }}>
                  {row.level2_current_index}/10 
                  <div style={{ 
                    width: '100px', 
                    height: '8px', 
                    background: 'var(--bg)', 
                    border: '1px solid var(--green)',
                    marginTop: '4px' 
                  }}>
                    <div style={{ 
                      width: `${(row.level2_current_index / 10) * 100}%`, 
                      height: '100%', 
                      background: 'var(--green)' 
                    }}></div>
                  </div>
                </td>
                <td style={{ padding: '0.5rem' }}>
                  {row.level2_completed_at 
                    ? new Date(row.level2_completed_at).toLocaleTimeString() 
                    : 'In progress...'}
                </td>
                <td style={{ padding: '0.5rem' }}>
                  {row.completion_time_seconds 
                    ? `${row.completion_time_seconds.toFixed(1)}s` 
                    : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      
      <button 
        onClick={() => { setLoading(true); void refresh(); }}
        style={{ marginTop: '1rem' }}
      >
        Refresh Leaderboard
      </button>
    </section>
  );
}
