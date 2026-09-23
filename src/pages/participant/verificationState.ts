export interface PairState {
  status: 'NOT_PAIRED' | 'PAIRED';
  participant_code: string;
  name: string;
  fragment_slot?: 'A' | 'B';
  wrong_attempts?: number;
  attempts_remaining?: number;
  is_locked?: boolean;
  self_verified?: boolean;
  partner_verified?: boolean;
  mutual_verified?: boolean;
}

export interface VerifyResult {
  status: 'VERIFIED' | 'INCORRECT' | 'LOCKED';
  self_verified: boolean;
  partner_verified?: boolean;
  mutual_verified?: boolean;
  attempts_remaining: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function attempts(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}

export function isPairState(value: unknown): value is PairState {
  if (!record(value) || typeof value.name !== 'string' || !value.name.trim() ||
      typeof value.participant_code !== 'string' || !value.participant_code.trim()) return false;
  const identityKeys = ['status', 'name', 'participant_code'];
  if (value.status === 'NOT_PAIRED') return onlyKeys(value, identityKeys);
  return value.status === 'PAIRED' &&
    onlyKeys(value, [...identityKeys, 'fragment_slot', 'wrong_attempts', 'attempts_remaining',
      'is_locked', 'self_verified', 'partner_verified', 'mutual_verified']) &&
    (value.fragment_slot === 'A' || value.fragment_slot === 'B') &&
    attempts(value.wrong_attempts) && attempts(value.attempts_remaining) &&
    value.attempts_remaining === 2 - value.wrong_attempts &&
    typeof value.is_locked === 'boolean' && typeof value.self_verified === 'boolean' &&
    typeof value.partner_verified === 'boolean' && typeof value.mutual_verified === 'boolean' &&
    value.mutual_verified === (value.self_verified && value.partner_verified) &&
    value.is_locked === (value.attempts_remaining === 0) &&
    !(value.is_locked && value.self_verified);
}

export function isVerifyResult(value: unknown): value is VerifyResult {
  if (!record(value) || !attempts(value.attempts_remaining)) return false;
  const keys = ['status', 'self_verified', 'attempts_remaining'];
  if (value.status === 'VERIFIED') {
    return onlyKeys(value, [...keys, 'partner_verified', 'mutual_verified']) &&
      value.self_verified === true && typeof value.partner_verified === 'boolean' &&
      typeof value.mutual_verified === 'boolean' &&
      value.mutual_verified === value.partner_verified && value.attempts_remaining > 0;
  }
  return onlyKeys(value, keys) && value.self_verified === false &&
    ((value.status === 'INCORRECT' && value.attempts_remaining === 1) ||
     (value.status === 'LOCKED' && value.attempts_remaining === 0));
}
