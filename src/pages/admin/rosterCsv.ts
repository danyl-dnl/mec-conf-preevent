/**
 * rosterCsv.ts — CSV parsing + conservative header auto-mapping.
 *
 * Uses PapaParse for robust CSV parsing.
 * Never trusts column positions — always uses headers.
 */

import Papa from "papaparse";
import type { ParsedCsv, FieldMapping, RequiredField } from "./rosterTypes";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface CsvParseError {
  type: "empty" | "no_headers" | "too_many_rows" | "parse_error";
  message: string;
}

const MAX_ROWS = 200;

export function parseCsvFile(
  file: File
): Promise<{ csv: ParsedCsv } | { error: CsvParseError }> {
  return new Promise((resolve) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete(result) {
        if (result.errors.length > 0 && result.data.length === 0) {
          resolve({
            error: {
              type: "parse_error",
              message: "Could not parse the CSV file. Ensure it is a valid CSV.",
            },
          });
          return;
        }

        const rows = result.data as string[][];

        if (rows.length === 0) {
          resolve({ error: { type: "empty", message: "The CSV file is empty." } });
          return;
        }

        const headers = rows[0].map((h) => h.trim());

        if (headers.length === 0 || headers.every((h) => h === "")) {
          resolve({ error: { type: "no_headers", message: "No header row found in the CSV." } });
          return;
        }

        const dataRows = rows.slice(1);

        if (dataRows.length > MAX_ROWS) {
          resolve({
            error: {
              type: "too_many_rows",
              message: `CSV contains ${dataRows.length} data rows. Maximum allowed is ${MAX_ROWS}.`,
            },
          });
          return;
        }

        resolve({ csv: { headers, rows: dataRows } });
      },
      error(err) {
        resolve({ error: { type: "parse_error", message: err.message } });
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Conservative header normalization + matching
// ---------------------------------------------------------------------------

/** Normalize a header for matching purposes only — NOT for storage */
function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Exact alias tables — conservative, no broad substrings.
 * "Parent Email" must NOT match Email.
 */
const ALIASES: Record<RequiredField, string[]> = {
  name: ["name", "full name", "participant name"],
  email: ["email", "email address", "e-mail"],
  branch: ["branch", "department", "dept", "class", "class / branch", "class/branch"],
};

/**
 * Attempts to automatically map CSV headers to required fields.
 * Returns null for any field that has zero or multiple matches (ambiguous).
 */
export function autoDetectMapping(headers: string[]): FieldMapping {
  const mapping: FieldMapping = { name: null, email: null, branch: null };

  for (const field of (["name", "email", "branch"] as RequiredField[])) {
    const aliases = ALIASES[field];
    const matchingIndices: number[] = [];

    headers.forEach((header, idx) => {
      const normalized = normalizeHeader(header);
      if (aliases.includes(normalized)) {
        matchingIndices.push(idx);
      }
    });

    // Exactly one confident match
    if (matchingIndices.length === 1) {
      mapping[field] = matchingIndices[0];
    }
    // Zero or multiple → leave null, require manual selection
  }

  return mapping;
}

/** Returns true when all three required fields are mapped */
export function isMappingComplete(mapping: FieldMapping): boolean {
  return mapping.name !== null && mapping.email !== null && mapping.branch !== null;
}

/**
 * Checks that no two different required fields map to the same column.
 * Returns the conflicting field names if a collision exists.
 */
export function getMappingConflicts(mapping: FieldMapping): RequiredField[] {
  const values = (["name", "email", "branch"] as RequiredField[])
    .map((f) => mapping[f])
    .filter((v) => v !== null);
  const hasDuplicates = values.length !== new Set(values).size;
  if (!hasDuplicates) return [];

  // Find which fields share an index
  const seen = new Map<number, RequiredField>();
  const conflicts: RequiredField[] = [];
  for (const field of ["name", "email", "branch"] as RequiredField[]) {
    const idx = mapping[field];
    if (idx === null) continue;
    if (seen.has(idx)) {
      conflicts.push(seen.get(idx)!);
      conflicts.push(field);
    } else {
      seen.set(idx, field);
    }
  }
  return [...new Set(conflicts)];
}

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

import type { RosterPayloadRow } from "./rosterTypes";

/**
 * Converts parsed CSV rows into the RPC payload format.
 * Filters out completely blank rows (all cells empty).
 * row_number: header = row 1, first data row = row 2.
 */
export function buildPayload(
  csv: ParsedCsv,
  mapping: FieldMapping
): RosterPayloadRow[] {
  const { rows, headers } = csv;
  const payload: RosterPayloadRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Pad row if it has fewer columns than the header
    const padded = headers.map((_, colIdx) => row[colIdx] ?? "");
    const isBlank = padded.every((cell) => cell.trim() === "");
    if (isBlank) continue;

    payload.push({
      row_number: i + 2, // +1 for 0-index → 1-index, +1 for header row
      name: padded[mapping.name!] ?? "",
      email: padded[mapping.email!] ?? "",
      branch: padded[mapping.branch!] ?? "",
    });
  }

  return payload;
}
