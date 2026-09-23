// ---------------------------------------------------------------------------
// Admin roster import — shared TypeScript types
// ---------------------------------------------------------------------------

// ── CSV parsing ─────────────────────────────────────────────────────────────

/** Raw parsed CSV: header row + data rows as string arrays */
export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

// ── Column mapping ───────────────────────────────────────────────────────────

/** The three required logical fields */
export type RequiredField = "name" | "email" | "branch";

/** Maps each logical field to a CSV column index (null = unresolved) */
export type FieldMapping = Record<RequiredField, number | null>;

// ── RPC payload ──────────────────────────────────────────────────────────────

/** One row sent to admin_preview_roster / admin_import_roster */
export interface RosterPayloadRow {
  row_number: number;
  name: string;
  email: string;
  branch: string | null;
}

// ── Backend preview response ─────────────────────────────────────────────────

/**
 * Primary database-state/action category returned by admin_preview_roster.
 * SUSPICIOUS_EMAIL is represented separately via is_suspicious_email.
 */
export type PreviewCategory =
  | "NEW"
  | "UNCHANGED"
  | "DETAILS_UPDATE"
  | "ALREADY_ACTIVE"
  | "DUPLICATE_IN_FILE"
  | "INVALID_EMAIL"
  | "MISSING_REQUIRED_FIELD"
  | "CONFLICT";

/** One row returned by admin_preview_roster */
export interface PreviewResultRow {
  row_number: number;
  category: PreviewCategory;
  is_blocking: boolean;
  is_suspicious_email: boolean;
  // Present for all rows (csv values)
  csv_name: string | null;
  csv_branch: string | null;
  // Present for rows matching an existing DB participant
  db_name: string | null;
  db_branch: string | null;
}

/** Full preview state */
export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; rows: PreviewResultRow[] }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Import Result
// ---------------------------------------------------------------------------

export interface ImportResult {
  success: boolean;
  imported: number;
  updated: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Roster List
// ---------------------------------------------------------------------------

export interface AdminParticipantRow {
  participant_code: string;
  name: string;
  branch: string | null;
  registered_email: string;
  is_linked: boolean;
}
