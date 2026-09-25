export type Level2State = 
  | { status: 'NOT_PAIRED' }
  | { status: 'NOT_STARTED' }
  | { status: 'PLAYING'; current_index: number; my_slot: 'A' | 'B'; is_my_turn: boolean; question?: string }
  | { status: 'COMPLETED'; started_at: string; completed_at: string; completion_time_seconds: number };

export function isLevel2State(data: any): data is Level2State {
  if (typeof data !== 'object' || data === null) return false;
  if (data.status === 'NOT_PAIRED' || data.status === 'NOT_STARTED') return true;
  if (data.status === 'PLAYING') {
    return typeof data.current_index === 'number' && 
           (data.my_slot === 'A' || data.my_slot === 'B') &&
           typeof data.is_my_turn === 'boolean' &&
           (data.is_my_turn ? typeof data.question === 'string' : true);
  }
  if (data.status === 'COMPLETED') {
    return typeof data.started_at === 'string' &&
           typeof data.completed_at === 'string' &&
           typeof data.completion_time_seconds === 'number';
  }
  return false;
}
