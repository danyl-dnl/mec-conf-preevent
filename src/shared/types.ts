export interface Participant {
  id: string;
  participantCode: string;
  name: string;
}

export interface PuzzleCell {
  row: number;
  col: number;
  value: string | null;
  shaded: boolean;
}

export interface PuzzleGrid {
  rows: number;
  cols: number;
  cells: PuzzleCell[];
}

export interface PartnerVerificationStatus {
  verified: boolean;
  mutualVerified: boolean;
  attemptsRemaining: number;
  locked: boolean;
}

export type LevelStatus =
  | "GRID_ASSIGNED"
  | "PARTNER_PENDING"
  | "MUTUALLY_VERIFIED"
  | "PUZZLE_SOLVED"
  | "PHOTO_PENDING"
  | "COMPLETED";