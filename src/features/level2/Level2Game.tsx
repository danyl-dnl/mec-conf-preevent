import { useCallback, useEffect, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { isLevel2State, type Level2State } from './types';
import './level2.css';

export default function Level2Game({ onCompletedChange }: { onCompletedChange: (completed: boolean) => void }) {
  const [state, setState] = useState<Level2State | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [message, setMessage] = useState('');
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++request.current;
    try {
      const { data, error } = await supabase.rpc('get_my_level2_state');
      if (error || !isLevel2State(data)) throw new Error('Invalid state');
      if (version !== request.current) return;
      setMessage('');
      setState(data);
      if (data.status === 'COMPLETED') {
        onCompletedChange(true);
      }
    } catch {
      if (version !== request.current) return;
      setMessage('Could not load Level 2 status.');
    } finally {
      if (version === request.current) setLoading(false);
    }
  }, [onCompletedChange]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      // Auto-refresh when it's not my turn
      if (state?.status === 'PLAYING' && !state.is_my_turn) {
        void refresh();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [refresh, state]);

  async function startLevel2() {
    setBusy(true);
    try {
      const { error } = await supabase.rpc('start_level2');
      if (error) throw error;
      await refresh();
    } catch {
      setMessage('Could not start Level 2.');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (loading || busy || state?.status !== 'PLAYING' || !state.is_my_turn || !answer.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const { data, error } = await supabase.rpc('submit_level2_answer', { answer_text: answer });
      if (error) throw error;
      if (data.status === 'INCORRECT') {
        setMessage('Incorrect answer. Try again.');
      } else {
        setAnswer('');
        setLoading(true);
        await refresh();
      }
    } catch {
      setMessage('Could not submit answer.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="level2-section" aria-label="Level 2 puzzle">
      <h2>LEVEL 2</h2>
      {loading && <p role="status">Loading Level 2 status...</p>}

      {!loading && state && (
        <>
          {state.status === 'NOT_PAIRED' && <p>You must be paired to play Level 2.</p>}

          {state.status === 'NOT_STARTED' && (
            <div>
              <p>Ready for Level 2? Both partners will answer 10 questions in total, taking turns.</p>
              <button disabled={busy} onClick={() => void startLevel2()}>
                {busy ? 'STARTING...' : 'START LEVEL 2'}
              </button>
            </div>
          )}

          {state.status === 'PLAYING' && (
            <div>
              <h3>Question {state.current_index + 1} of 10</h3>
              {state.is_my_turn ? (
                <div>
                  <p className="question-text"><strong>{state.question}</strong></p>
                  <form onSubmit={e => { e.preventDefault(); void submit(); }}>
                    <label>
                      Answer:
                      <input
                        value={answer}
                        onChange={e => setAnswer(e.target.value)}
                        disabled={busy}
                        autoComplete="off"
                        autoFocus
                      />
                    </label>
                    <button type="submit" disabled={busy || !answer.trim()}>
                      {busy ? 'SUBMITTING...' : 'SUBMIT ANSWER'}
                    </button>
                  </form>
                </div>
              ) : (
                <div className="waiting-screen">
                  <div className="spinner"></div>
                  <p>Waiting for your partner to answer Question {state.current_index + 1}...</p>
                </div>
              )}
            </div>
          )}

          {state.status === 'COMPLETED' && (
            <div role="status">
              <h3>LEVEL 2 COMPLETED!</h3>
              <p>Time: {state.completion_time_seconds.toFixed(2)} seconds</p>
            </div>
          )}
        </>
      )}

      {message && <p className="level2-message" role="alert">{message}</p>}

      <button
        type="button"
        disabled={loading || busy}
        onClick={() => { setLoading(true); void refresh(); }}
        style={{ marginTop: '20px' }}
      >
        Refresh Status
      </button>
    </section>
  );
}
