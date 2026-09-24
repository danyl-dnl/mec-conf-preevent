import { useState } from 'react';
import type { RosterPayloadRow } from './rosterTypes';
import { manualParticipantPayload } from './manualParticipant';

export default function ManualParticipantForm({ disabled, onPreview, onEdit }: {
  disabled: boolean;
  onPreview: (payload: RosterPayloadRow[]) => void;
  onEdit: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [branch, setBranch] = useState('');
  const [error, setError] = useState('');
  const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box' as const,
    marginTop: 8, padding: 12, background: '#050905', color: '#39ff14',
    border: '1px solid rgba(57,255,20,0.55)', font: 'inherit', fontSize: 16 };
  return <form aria-label="Add participant manually" onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    try { const payload = manualParticipantPayload(name, email, branch); setError(''); onPreview(payload); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Check participant details.'); }
  }}>
    <p style={{ fontSize: 13, lineHeight: 1.7 }}>Enter participant details without uploading a CSV. Review the server preview below, then confirm to save.</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 16 }}>
      <label>Name<input style={inputStyle} value={name} required maxLength={100} autoComplete="off" disabled={disabled}
        onChange={event => { setName(event.target.value); setError(''); onEdit(); }} /></label>
      <label>Email address<input style={inputStyle} type="email" value={email} required maxLength={255} autoComplete="off" disabled={disabled}
        onChange={event => { setEmail(event.target.value); setError(''); onEdit(); }} /></label>
      <label>Branch<input style={inputStyle} value={branch} required maxLength={50} autoComplete="off" disabled={disabled}
        onChange={event => { setBranch(event.target.value); setError(''); onEdit(); }} /></label>
    </div>
    <p style={{ fontSize: 12 }}>Branch is required by the roster. Participant ID is generated automatically when saved.</p>
    <button type="submit" disabled={disabled} style={{ padding: '14px 20px', background: '#39ff14', color: '#050905', border: 0,
      font: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      [ REVIEW PARTICIPANT ]
    </button>
    {error && <p role="alert" style={{ color: '#ff4444' }}>{error}</p>}
  </form>;
}
