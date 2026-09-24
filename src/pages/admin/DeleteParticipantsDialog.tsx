import { useEffect, useId, useRef } from 'react';
import type { AdminParticipantRow } from './rosterTypes';
export default function DeleteParticipantsDialog({ participants, busy, onCancel, onConfirm }: {
  participants: AdminParticipantRow[]; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
  }, []);
  const button = { padding: '12px 18px', background: 'transparent', color: '#39ff14', border: '1px solid currentColor', font: 'inherit' };
  return <dialog ref={dialog} aria-labelledby={title} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
    style={{ background: '#050905', color: '#39ff14', border: '1px solid #39ff14', padding: 24, width: 'min(560px, calc(100vw - 32px))', boxSizing: 'border-box' }}>
    <h3 id={title}>Delete {participants.length === 1 ? 'this participant' : `${participants.length} participants`}?</h3>
    <p>This removes their roster entries and event access. Google accounts are not deleted.</p>
    <ul style={{ maxHeight: '40vh', overflowY: 'auto', paddingLeft: 24, overflowWrap: 'anywhere', lineHeight: 1.7 }}>
      {participants.map(row => <li key={row.participant_code}>{row.name} · {row.participant_code}<br />{row.registered_email}</li>)}
    </ul>
    <p>Paired participants are protected. If any selection is paired, nothing will be deleted.</p>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <button ref={cancel} type="button" disabled={busy} onClick={onCancel} style={button}>CANCEL</button>
      <button type="button" disabled={busy} onClick={onConfirm} style={{ ...button, color: '#ff6666' }}>
        {busy ? 'DELETING…' : `DELETE ${participants.length === 1 ? 'PARTICIPANT' : `${participants.length} PARTICIPANTS`}`}
      </button>
    </div>
  </dialog>;
}
