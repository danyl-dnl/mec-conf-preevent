import { useEffect, useId, useRef } from 'react';
import type { AdminParticipantRow } from './rosterTypes';
export default function DeleteParticipantsDialog({ participants, pairedMap, busy, onCancel, onConfirm }: {
  participants: AdminParticipantRow[];
  pairedMap?: Map<string, string>;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
  }, []);

  const pairedSelected = participants.filter(p => pairedMap?.has(p.participant_code));
  const button = { padding: '12px 18px', background: 'transparent', color: '#39ff14', border: '1px solid currentColor', font: 'inherit', cursor: 'pointer' };

  return <dialog ref={dialog} aria-labelledby={title} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
    style={{ background: '#050905', color: '#39ff14', border: '1px solid #39ff14', padding: 24, width: 'min(560px, calc(100vw - 32px))', boxSizing: 'border-box' }}>
    <h3 id={title}>Delete {participants.length === 1 ? 'this participant' : `${participants.length} participants`}?</h3>
    <p>This removes their roster entries and event access. Google accounts are not deleted.</p>
    <ul style={{ maxHeight: '40vh', overflowY: 'auto', paddingLeft: 24, overflowWrap: 'anywhere', lineHeight: 1.7 }}>
      {participants.map(row => {
        const pairCode = pairedMap?.get(row.participant_code);
        return (
          <li key={row.participant_code}>
            {row.name} · {row.participant_code} {pairCode ? <span style={{ color: '#ffaa00', fontSize: '11px' }}>[PAIRED: {pairCode}]</span> : null}
            <br />
            {row.registered_email}
          </li>
        );
      })}
    </ul>
    {pairedSelected.length > 0 ? (
      <div style={{ padding: '12px', background: 'rgba(255, 170, 0, 0.15)', border: '1px solid #ffaa00', margin: '14px 0', color: '#ffcc66', lineHeight: 1.5, fontSize: '13px' }}>
        ⚠️ <strong>Notice:</strong> {pairedSelected.length === 1
          ? `The person you selected (${pairedSelected[0].name} - ${pairedSelected[0].participant_code}) is already paired in ${pairedMap?.get(pairedSelected[0].participant_code)}. Deleting them will unpair their partner and dissolve the pair.`
          : `Some participants you selected are already paired. Deleting them will unpair their partners and dissolve their pairs.`}
      </div>
    ) : (
      <p style={{ color: '#888', fontSize: '12px' }}>Note: If a selected participant is already paired, deleting them will dissolve their pair and leave their partner unpaired.</p>
    )}
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <button ref={cancel} type="button" disabled={busy} onClick={onCancel} style={button}>CANCEL</button>
      <button type="button" disabled={busy} onClick={onConfirm} style={{ ...button, color: '#ff6666' }}>
        {busy ? 'DELETING…' : `DELETE ${participants.length === 1 ? 'PARTICIPANT' : `${participants.length} PARTICIPANTS`}`}
      </button>
    </div>
  </dialog>;
}
