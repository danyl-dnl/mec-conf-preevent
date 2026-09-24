export function randomPairPlan<T extends { participant_code: string }>(participants: readonly T[]) {
  if (new Set(participants.map(p => p.participant_code)).size !== participants.length) {
    throw new Error('Duplicate participant codes. Refresh the participant list.');
  }
  const shuffled = [...participants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const pairs: [T, T][] = [];
  for (let i = 0; i + 1 < shuffled.length; i += 2) pairs.push([shuffled[i], shuffled[i + 1]]);
  return { pairs, leftover: shuffled.length % 2 ? shuffled[shuffled.length - 1] : null };
}

// Each existing create RPC is atomic. Stop on the first uncertain/failed request;
// earlier confirmed pairs remain saved, and the caller must refresh before retrying.
export async function saveRandomPairs<T>(pairs: readonly [T, T][], create: (a: T, b: T) => Promise<void>) {
  let created = 0;
  for (const [a, b] of pairs) {
    try { await create(a, b); created++; }
    catch { return { created, complete: false }; }
  }
  return { created, complete: true };
}
