import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { isAnswerResult, isLevel1State, type Level1State } from './types';
import PairPhotoUpload from './PairPhotoUpload';
import PuzzleGrid from './PuzzleGrid';
import { isPaperFragment } from './paperGrid';
import './level1.css';

export default function ParticipantPuzzle({ refreshToken, onCompletedChange }: { refreshToken: number; onCompletedChange: (completed: boolean) => void }) {
  const [state, setState] = useState<Level1State | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++request.current;
    try {
      const { data, error } = await supabase.rpc('get_my_level1_state');
      if (error || !isLevel1State(data)) throw new Error('Invalid state');
      if (version !== request.current) return;
      setMessage('');
      setState(data);
      onCompletedChange(data.completed);
      setFailed(false);
    } catch {
      if (version !== request.current) return;
      setFailed(true);
      setMessage('Could not load Level 1 status. Refresh status to try again.');
    } finally {
      if (version === request.current) setLoading(false);
    }
  }, [onCompletedChange]);
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- Refresh synchronizes RPC state; updates follow the network response.
    void refresh();
  }, [refresh, refreshToken]);

  async function submit() {
    if (inFlight.current || loading || failed || state?.status !== 'READY_TO_SOLVE' || !answer.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const { data, error } = await supabase.rpc('submit_level1_answer', { answer });
      if (error || !isAnswerResult(data)) throw new Error('Invalid answer response');
      if (data.status === 'INCORRECT') {
        setMessage('Verification failed. Check the combined grid and try again.');
      } else {
        setAnswer('');
        setLoading(true);
        await refresh();
      }
    } catch {
      setFailed(true);
      setMessage('Could not confirm the answer result. Refresh status before trying again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <section className="level1-section" aria-label="Level 1 puzzle">
    <h2>LEVEL 1</h2>
    {loading && <p role="status">Loading puzzle status...</p>}
    {state?.assigned_grid && <>
      <h3>FRAGMENT {state.fragment_slot}</h3>
      <PuzzleGrid grid={state.assigned_grid} label={`Fragment ${state.fragment_slot}`} />
      {isPaperFragment(state.assigned_grid) && <p>
        Compare each cell with the same cell on your partner’s grid. If either cell is shaded, ignore that position.
        If neither cell is shaded and a number appears, keep the number.
        Convert the surviving numbers using A=1, B=2, … Y=25 and find the hidden keyword.
      </p>}
    </>}
    {!loading && !failed && <>
      {state?.status === 'NOT_PAIRED' && <p>Pair assignment pending.</p>}
      {state?.status === 'NO_PUZZLE' && <p>Puzzle assignment pending.</p>}
      {state?.status === 'FIND_PARTNER' && <p>Find the participant holding the complementary fragment.</p>}
      {state?.status === 'READY_TO_SOLVE' && <>
        <h3>CONNECTION ESTABLISHED</h3>
        <p>Combine your fragments to discover the hidden keyword.</p>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label>Final answer<input value={answer} onChange={event => setAnswer(event.target.value)} maxLength={1024} disabled={busy} autoComplete="off" /></label>
          <button disabled={busy || !answer.trim()}>{busy ? 'VERIFYING...' : 'VERIFY ANSWER'}</button>
        </form>
      </>}
      {state?.status === 'SOLVED' && <div>
        <h3>GRID VERIFIED</h3>
        <p>Level 1 puzzle solved.</p>
        <PairPhotoUpload onComplete={refresh} onBusyChange={setBusy} />
      </div>}
      {state?.status === 'COMPLETED' && <div role="status">
        <h2>TRANSMISSION COMPLETE</h2>
        <h3>LEVEL 1 COMPLETE</h3>
        <p>Your pair has successfully completed the challenge.</p>
        <p>{state.participant_code} · FRAGMENT {state.fragment_slot}</p>
      </div>}
    </>}
    {message && <p className="level1-message" role="alert">{message}</p>}
    <button type="button" disabled={loading || busy} onClick={() => { setLoading(true); void refresh(); }}>Refresh Puzzle Status</button>
  </section>;
}
