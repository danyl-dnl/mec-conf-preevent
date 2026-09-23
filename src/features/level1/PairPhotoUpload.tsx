import { useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { isCompletionResult, isRecord } from './types';

const messages: Record<string, string> = {
  UPLOAD_NOT_CONFIGURED: 'Photo upload is not configured yet. Contact an organizer.',
  UNAUTHENTICATED: 'Your session has expired. Please sign in again.',
  ALREADY_COMPLETED: 'Your partner has already uploaded a photo. Refresh status to see completion.',
  UPLOAD_IN_PROGRESS: 'A pair photo upload is in progress. Refresh status shortly.',
  NOT_ELIGIBLE: 'Both participants must verify and solve the puzzle before uploading.',
  INVALID_FILE: 'Choose a JPEG, PNG, WebP, GIF, HEIC, HEIF, or AVIF photo.',
  FILE_TOO_LARGE: 'Choose a photo that is 5 MB or smaller.',
  UPLOAD_FAILED: 'Photo upload failed. Check your connection and try another photo.',
};

export default function PairPhotoUpload({ onComplete, onBusyChange }: { onComplete: () => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  async function upload() {
    if (!file || inFlight.current || refreshRequired) return;
    if (!file.type.startsWith('image/') || !file.size || file.size > 5 * 1024 * 1024) {
      setMessage('Choose an image that is 5 MB or smaller.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setMessage('');
    try {
      const body = new FormData();
      body.set('photo', file);
      // The browser sends only the file. The Edge Function resolves all identity.
      const { data, error } = await supabase.functions.invoke('upload-pair-photo', { body });
      if (error) {
        let code = '';
        if (isRecord(error) && error.context instanceof Response) {
          try {
            const details: unknown = await error.context.json();
            if (isRecord(details) && typeof details.code === 'string') code = details.code;
          } catch { /* Use safe fallback text for non-JSON gateway errors. */ }
        }
        if (code === 'ALREADY_COMPLETED') {
          setRefreshRequired(true);
          await onComplete();
          return;
        }
        setMessage(messages[code] ?? 'Upload could not be confirmed. Refresh status before retrying.');
        if (!messages[code] || code === 'UPLOAD_IN_PROGRESS') setRefreshRequired(true);
        return;
      }
      if (!isCompletionResult(data)) throw new Error('Invalid upload response');
      setRefreshRequired(true);
      await onComplete();
    } catch {
      setRefreshRequired(true);
      setMessage('Upload could not be confirmed. Refresh status before retrying.');
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }
  return <div>
    <h3>ONE LAST STEP</h3>
    <p>Upload one photo with your partner to complete Level 1.</p>
    <label>Choose Photo<input type="file" accept="image/*" disabled={busy || refreshRequired} onChange={event => {
      setFile(event.target.files?.[0] ?? null); setMessage('');
    }} /></label>
    {file && <p style={{ overflowWrap: 'anywhere' }}>Selected: {file.name}</p>}
    <p>Maximum 5 MB. Only one photo is needed for your pair.</p>
    <button type="button" disabled={!file || busy || refreshRequired} onClick={() => void upload()}>
      {busy ? 'UPLOADING...' : 'UPLOAD PAIR PHOTO'}
    </button>
    {busy && <p role="status">Uploading your pair photo. Please wait...</p>}
    {message && <p role="alert">{message}</p>}
  </div>;
}
