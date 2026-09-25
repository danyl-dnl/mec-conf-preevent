import { useState, useEffect, useRef, useId, useCallback } from "react";
import { randomPairPlan, saveRandomPairs } from "./randomPairs";
import DeleteParticipantsDialog from "./DeleteParticipantsDialog";
import { selectedRosterRows, toggleRosterSelection } from "./rosterSelection";
import ManualParticipantForm from "./ManualParticipantForm";
import AdminProgress from "../../features/level1/AdminProgress";
import AdminLevel2Progress from "../../features/level2/AdminLevel2Progress";
import AdminManagement from "./AdminManagement";
import { supabase } from "../../lib/supabase";
import {
  parseCsvFile,
  autoDetectMapping,
  isMappingComplete,
  getMappingConflicts,
  buildPayload,
} from "./rosterCsv";
import type {
  ParsedCsv,
  FieldMapping,
  RequiredField,
  PreviewResultRow,
  PreviewCategory,
  PreviewState,
  RosterPayloadRow,
  AdminParticipantRow,
  ImportResult,
  UnpairedParticipant,
  AdminPairRow,
  CreatePairResult,
} from "./rosterTypes";

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const GREEN = "#39ff14";
const GREEN_DIM = "rgba(57,255,20,0.55)";
const GREEN_FAINT = "rgba(57,255,20,0.12)";
const GREEN_GLOW = "rgba(57,255,20,0.08)";
const BG = "#050905";
const RED = "#ff4444";
const RED_FAINT = "rgba(255,68,68,0.12)";
const AMBER = "#ffb347";
const GREY = "rgba(57,255,20,0.30)";
const MONO = "'Courier New', Courier, monospace";

// ---------------------------------------------------------------------------
// Auth types
// ---------------------------------------------------------------------------

type AdminStatus = "loading" | "unauthenticated" | "is_admin" | "not_admin" | "error";

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export default function AdminHome() {
  const [status, setStatus] = useState<AdminStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = BG;
    return () => { document.body.style.background = prev; };
  }, []);

  useEffect(() => { checkSessionAndAdminStatus(); }, []);

  async function checkSessionAndAdminStatus() {
    setStatus("loading");
    setErrorMessage(null);
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) { setStatus("unauthenticated"); return; }
    await performAdminCheck();
  }

  async function performAdminCheck() {
    setStatus("loading");
    setErrorMessage(null);
    const { data, error: rpcError } = await supabase.rpc("check_admin_status");
    if (rpcError) {
      console.error("check_admin_status:", rpcError.message);
      setErrorMessage("Could not reach the server. Check your connection and try again.");
      setStatus("error");
      return;
    }
    const result = data as string | null;
    if (result === "IS_ADMIN") setStatus("is_admin");
    else if (result === "NOT_ADMIN") setStatus("not_admin");
    else {
      setErrorMessage("An unexpected response was received. Please try again.");
      setStatus("error");
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setErrorMessage(null);
    setStatus("unauthenticated");
  }

  async function handleGoogleSignIn() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + "/admin" },
    });
    if (error) console.error("Google sign-in failed:", error.message);
  }

  return (
    <div style={{
      background: BG, minHeight: "100svh", display: "flex", flexDirection: "column",
      alignItems: "center", fontFamily: MONO, color: GREEN, boxSizing: "border-box"
    }}>

      {/* Narrow auth card for non-admin states */}
      {status !== "is_admin" && (
        <div style={{
          width: "100%", maxWidth: "420px", padding: "32px 24px", display: "flex",
          flexDirection: "column", flexGrow: 1, justifyContent: "center"
        }}>
          <div style={{ fontSize: "11px", letterSpacing: "0.18em", color: GREEN_DIM, marginBottom: "40px", lineHeight: "1.8" }}>
            MEC.CONF 2026&nbsp;&nbsp;//&nbsp;&nbsp;ADMIN
          </div>

          {status === "loading" && <LoadingView />}
          {status === "unauthenticated" && <LoginView onSignIn={handleGoogleSignIn} />}
          {status === "not_admin" && <DeniedView onSignOut={handleSignOut} />}
          {status === "error" && (
            <ErrorView message={errorMessage} onRetry={performAdminCheck} onSignOut={handleSignOut} />
          )}
        </div>
      )}

      {/* Full-width dashboard for confirmed admins */}
      {status === "is_admin" && (
        <AdminDashboard onSignOut={handleSignOut} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin dashboard (is_admin confirmed)
// ---------------------------------------------------------------------------


function AdminDashboard({ onSignOut }: { onSignOut: () => void }) {
  const [rosterRefreshToken, setRosterRefreshToken] = useState(0);
  const onPairsChanged = useCallback(() => setRosterRefreshToken(value => value + 1), []);
  const [roster, setRoster] = useState<AdminParticipantRow[] | null>(null);
  const [isRosterLoading, setIsRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);

  useEffect(() => {
    fetchRoster();
  }, []);

  async function fetchRoster() {
    setIsRosterLoading(true);
    setRosterError(null);
    const { data, error } = await supabase.rpc("admin_list_participants");
    setIsRosterLoading(false);
    if (error) {
      console.error(error);
      setRosterError("Failed to load roster.");
      return;
    }

    if (!Array.isArray(data)) {
      setRosterError("Unexpected response from server.");
      return;
    }

    const validRoster: AdminParticipantRow[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      if (typeof r.participant_code === "string" && typeof r.name === "string" &&
        (typeof r.branch === "string" || r.branch === null) &&
        typeof r.registered_email === "string" && typeof r.is_linked === "boolean") {
        validRoster.push({
          participant_code: r.participant_code,
          name: r.name,
          branch: r.branch,
          registered_email: r.registered_email,
          is_linked: r.is_linked
        });
      }
    }

    setRoster(validRoster);
    setRosterRefreshToken(value => value + 1);
  }

  return (
    <div style={{ width: "100%", maxWidth: "1100px", padding: "32px 24px", boxSizing: "border-box" }}>
      {/* Header bar */}
      <div style={{
        display: "flex", alignItems: "baseline", justifyContent: "space-between",
        borderBottom: `1px solid ${GREEN_FAINT}`, paddingBottom: "16px", marginBottom: "40px",
        flexWrap: "wrap", gap: "12px"
      }}>
        <div>
          <div style={{ fontSize: "11px", letterSpacing: "0.18em", color: GREEN_DIM, marginBottom: "6px" }}>
            MEC.CONF 2026 &nbsp;//&nbsp; ADMIN CONSOLE
          </div>
          <div style={{ fontSize: "22px", fontWeight: "bold", letterSpacing: "0.04em", color: GREEN }}>
            ORGANIZER DASHBOARD
          </div>
        </div>
        <button id="btn-admin-sign-out" type="button" onClick={onSignOut} style={secondaryBtnStyle}>
          [ SIGN OUT ]
        </button>
      </div>

      <RosterSection onImportSuccess={fetchRoster} />

      <AdminRosterList roster={roster} isLoading={isRosterLoading} error={rosterError} onRefresh={fetchRoster} onPairsChanged={onPairsChanged} />

      <PairSection onPairsChanged={onPairsChanged} refreshToken={rosterRefreshToken} />
      <AdminManagement />
      <AdminProgress />
      <AdminLevel2Progress />
    </div>
  );
}
// ---------------------------------------------------------------------------
// Roster section — the main Phase 1 feature
// ---------------------------------------------------------------------------

function RosterSection({ onImportSuccess }: { onImportSuccess: () => void }) {
  const [manualSource, setManualSource] = useState(false);
  const [manualVersion, setManualVersion] = useState(0);
  const previewInFlight = useRef(false);
  function invalidateManualPreview() {
    if (!manualSource) return;
    setPreview({ status: "idle" });
    setPreviewPayload([]);
    setIsSuspiciousAcknowledged(false);
    setImportResult(null);
    setImportError(null);
    setShowConfirmModal(false);
  }
  // ── File / CSV state ────────────────────────────────────────────────────
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Column mapping state ─────────────────────────────────────────────────
  const [mapping, setMapping] = useState<FieldMapping>({ name: null, email: null, branch: null });

  // ── Preview state ────────────────────────────────────────────────────────
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [isPreviewing, setIsPreviewing] = useState(false);
  // Keep the payload that generated the current preview for email display
  const [previewPayload, setPreviewPayload] = useState<RosterPayloadRow[]>([]);

  const [isSuspiciousAcknowledged, setIsSuspiciousAcknowledged] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);


  // Reset all derived state whenever the CSV changes
  function resetToFile() {
    setCsv(null);
    setCsvError(null);
    setFileName(null);
    setMapping({ name: null, email: null, branch: null });

    setPreview({ status: "idle" });
    setPreviewPayload([]);
    setIsSuspiciousAcknowledged(false);
    setImportResult(null);
    setImportError(null);
    setShowConfirmModal(false);

    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ── File selection handler ───────────────────────────────────────────────
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setManualSource(false);
    // Clear previous results immediately when a new file is chosen
    setCsv(null);
    setCsvError(null);
    setMapping({ name: null, email: null, branch: null });

    setPreview({ status: "idle" });
    setPreviewPayload([]);
    setIsSuspiciousAcknowledged(false);
    setImportResult(null);
    setImportError(null);
    setShowConfirmModal(false);

    setFileName(file.name);
    setIsParsing(true);

    const result = await parseCsvFile(file);
    setIsParsing(false);

    if ("error" in result) {
      setCsvError(result.error.message);
      return;
    }

    const detected = autoDetectMapping(result.csv.headers);
    setCsv(result.csv);
    setMapping(detected);
  }

  // Updating a single mapping field clears any stale preview
  function updateMapping(field: RequiredField, colIdx: number | null) {
    setMapping((prev) => ({ ...prev, [field]: colIdx }));
    setPreview({ status: "idle" }); // stale preview cleared
    setPreviewPayload([]);
  }

  // ── Preview RPC ──────────────────────────────────────────────────────────
  async function handleRequestPreview(manualPayload?: RosterPayloadRow[]) {
    if (previewInFlight.current || isImporting || isParsing) return;
    if (!manualPayload && (!csv || !isMappingComplete(mapping) || getMappingConflicts(mapping).length > 0)) return;
    const payload = manualPayload ?? buildPayload(csv!, mapping);
    setManualSource(!!manualPayload);
    setIsSuspiciousAcknowledged(false);
    setImportResult(null);
    setImportError(null);
    setShowConfirmModal(false);

    if (payload.length === 0) {
      setPreview({ status: "error", message: "No data rows found after filtering blank rows." });
      return;
    }

    previewInFlight.current = true;
    setIsPreviewing(true);
    setPreview({ status: "loading" });
    setPreviewPayload(payload);

    let response;
    try { response = await supabase.rpc("admin_preview_roster", { payload }); }
    catch {
      setPreview({ status: "error", message: "Preview request failed. Check your connection and try again." });
      return;
    } finally {
      previewInFlight.current = false;
      setIsPreviewing(false);
    }
    const { data, error } = response;

    if (error) {
      console.error("admin_preview_roster:", error.message);
      const isPermission = error.message.toLowerCase().includes("permission");
      setPreview({
        status: "error",
        message: isPermission
          ? "Access denied. Your account does not have organizer privileges."
          : "Preview request failed. Check your connection and try again.",
      });
      return;
    }

    // Narrow the RPC response
    if (!Array.isArray(data)) {
      setPreview({ status: "error", message: "Unexpected response from server." });
      return;
    }

    // Validate each row has required shape
    const rows: PreviewResultRow[] = [];
    for (const item of data as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      rows.push({
        row_number: typeof r.row_number === "number" ? r.row_number : 0,
        category: (r.category as PreviewCategory) ?? "CONFLICT",
        is_blocking: Boolean(r.is_blocking),
        is_suspicious_email: Boolean(r.is_suspicious_email),
        csv_name: typeof r.csv_name === "string" ? r.csv_name : null,
        csv_branch: typeof r.csv_branch === "string" ? r.csv_branch : null,
        db_name: typeof r.db_name === "string" ? r.db_name : null,
        db_branch: typeof r.db_branch === "string" ? r.db_branch : null,
      });
    }

    setPreview({ status: "success", rows });
  }


  // ── Import RPC ───────────────────────────────────────────────────────────
  async function handleConfirmImport() {
    setIsImporting(true);
    setImportError(null);
    const { data, error } = await supabase.rpc("admin_import_roster", { payload: previewPayload });
    setIsImporting(false);
    setShowConfirmModal(false);

    if (error) {
      console.error(error);
      setImportError("We couldn't confirm whether the import completed. Refresh the roster and run a fresh preview before trying again.");
      return;
    }

    if (typeof data !== "object" || data === null) {
      setImportError("Unexpected response format from server. Refresh the roster and try again.");
      return;
    }

    const r = data as Record<string, unknown>;
    if (r.success !== true ||
      typeof r.imported !== "number" || r.imported < 0 || !Number.isFinite(r.imported) ||
      typeof r.updated !== "number" || r.updated < 0 || !Number.isFinite(r.updated) ||
      typeof r.skipped !== "number" || r.skipped < 0 || !Number.isFinite(r.skipped)) {
      setImportError("Invalid success confirmation from server. Refresh the roster and try again.");
      return;
    }

    setImportResult({
      success: true,
      imported: r.imported,
      updated: r.updated,
      skipped: r.skipped
    });
    // Explicitly reset UI to success state
    setCsv(null);
    setCsvError(null);
    setFileName(null);
    setMapping({ name: null, email: null, branch: null });
    setPreview({ status: "idle" });
    setPreviewPayload([]);
    setIsSuspiciousAcknowledged(false);
    if (fileInputRef.current) fileInputRef.current.value = "";

    if (manualSource) setManualVersion(value => value + 1);
    onImportSuccess();
  }

  // ── Computed summary counts ──────────────────────────────────────────────
  const mappingConflicts = getMappingConflicts(mapping);
  const mappingReady = isMappingComplete(mapping) && mappingConflicts.length === 0;

  return (
    <section aria-labelledby="roster-section-heading">
      <h2 id="roster-section-heading" style={{
        fontSize: "13px", letterSpacing: "0.16em",
        color: GREEN_DIM, marginBottom: "28px", fontWeight: "normal"
      }}>
        &gt;&gt; SECTION: ROSTER_MANAGEMENT
      </h2>

      <SectionBlock label="ADD PARTICIPANT MANUALLY">
        <ManualParticipantForm key={manualVersion} disabled={isImporting || isPreviewing || isParsing || showConfirmModal}
          onEdit={invalidateManualPreview} onPreview={payload => {
            resetToFile();
            void handleRequestPreview(payload);
          }} />
      </SectionBlock>

      {/* ── Step 1: File upload ── */}
      <SectionBlock label="01  UPLOAD REGISTRATION CSV">
        <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
          <label htmlFor="csv-file-input" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "12px", color: GREEN_DIM, letterSpacing: "0.08em" }}>
              Select a .csv file exported from Google Forms / Sheets:
            </span>
            <input
              id="csv-file-input"
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              disabled={isParsing || isPreviewing || isImporting || showConfirmModal}
              style={{
                fontFamily: MONO, fontSize: "13px", color: GREEN,
                background: GREEN_GLOW, border: `1px solid ${GREY}`,
                padding: "10px 14px", cursor: "pointer", outline: "none",
                letterSpacing: "0.04em",
              }}
            />
          </label>
          {(csv || csvError) && (
            <button type="button" onClick={resetToFile} disabled={isPreviewing || isImporting} style={{ ...secondaryBtnStyle, width: "auto", padding: "10px 18px" }}>
              [ CLEAR / RESET ]
            </button>
          )}
        </div>

        {isParsing && <StatusLine text="Parsing CSV..." />}

        {csvError && (
          <ErrorBox message={csvError} />
        )}

        {csv && !csvError && (
          <div style={{ marginTop: "14px", fontSize: "13px", color: GREEN_DIM, lineHeight: "1.8" }}>
            <span style={{ color: GREEN }}>✓</span>&nbsp;
            <strong style={{ color: GREEN }}>{fileName}</strong>
            &nbsp;— {csv.headers.length} columns, {csv.rows.length} data rows detected.
          </div>
        )}
      </SectionBlock>

      {/* ── Step 2: Column mapping ── */}
      {csv && (
        <SectionBlock label="02  MAP COLUMNS">
          <p style={{ fontSize: "13px", color: GREEN_DIM, marginBottom: "20px", lineHeight: "1.7" }}>
            Map each required field to the correct CSV column.
            Auto-detection is conservative — confirm or correct below.
          </p>
          <MappingForm
            headers={csv.headers}
            mapping={mapping}
            conflicts={mappingConflicts}
            onUpdate={updateMapping}
          />
          {mappingConflicts.length > 0 && (
            <ErrorBox message="Two or more fields are mapped to the same CSV column. Each field must use a unique column." />
          )}
          {mappingReady && (
            <div style={{ marginTop: "14px", fontSize: "12px", color: GREEN_DIM }}>
              <span style={{ color: GREEN }}>✓</span>&nbsp;All required fields are mapped. Ready to preview.
            </div>
          )}
        </SectionBlock>
      )}

      {/* ── Step 3: Request preview ── */}
      {csv && mappingReady && (
        <SectionBlock label="03  SERVER PREVIEW">
          <p style={{ fontSize: "13px", color: GREEN_DIM, marginBottom: "20px", lineHeight: "1.7" }}>
            Send the parsed data to the server for authoritative classification.
            No participants will be changed at this step.
          </p>
          <button
            id="btn-request-preview"
            type="button"
            onClick={() => { void handleRequestPreview(); }}
            disabled={isPreviewing || isImporting || preview.status === "loading"}
            style={{ ...primaryBtnStyle, width: "auto", padding: "14px 28px" }}
          >
            {isPreviewing ? "[ REQUESTING PREVIEW... ]" : "[ REQUEST SERVER PREVIEW ]"}
          </button>
        </SectionBlock>
      )}

      {/* ── Preview results ── */}
      {preview.status === "loading" && (
        <SectionBlock label="04  PREVIEW RESULTS">
          <StatusLine text="Contacting server..." />
        </SectionBlock>
      )}

      {preview.status === "error" && (
        <SectionBlock label="04  PREVIEW RESULTS">
          <ErrorBox message={preview.message} />
        </SectionBlock>
      )}

      {preview.status === "success" && (
        <SectionBlock label="04  PREVIEW RESULTS">
          <PreviewResults rows={preview.rows} payloadMap={Object.fromEntries(previewPayload.map(r => [r.row_number, r]))} />
        </SectionBlock>
      )}

      {/* ── Import Success / Error ── */}
      {importResult && (
        <SectionBlock label="05  IMPORT COMPLETE">
          <div style={{ fontSize: "13px", color: GREEN_DIM, lineHeight: "1.8" }}>
            <span style={{ color: GREEN, fontWeight: "bold" }}>Import complete</span><br /><br />
            Imported: {importResult.imported}<br />
            Updated: {importResult.updated}<br />
            Skipped: {importResult.skipped}<br />
            <br />
            {importResult.success && <span style={{ color: GREEN }}>Roster refreshed.</span>}
          </div>
        </SectionBlock>
      )}

      {importError && (
        <SectionBlock label="05  IMPORT FAILED">
          <ErrorBox message={importError} />
        </SectionBlock>
      )}

      {/* ── Confirm Import ── */}
      {preview.status === "success" && !importResult && (
        <SectionBlock label="05  CONFIRM IMPORT">
          {(() => {
            const counts = {
              new_: preview.rows.filter((r) => r.category === "NEW").length,
              updates: preview.rows.filter((r) => r.category === "DETAILS_UPDATE").length,
              skipped: preview.rows.filter((r) => r.category === "UNCHANGED" || r.category === "ALREADY_ACTIVE").length,
              problems: preview.rows.filter((r) => r.is_blocking).length,
              warnings: preview.rows.filter((r) => r.is_suspicious_email && !r.is_blocking).length,
            };
            const isEligible = counts.problems === 0 && (!counts.warnings || isSuspiciousAcknowledged) && !isImporting;

            return (
              <div>
                <div style={{ fontSize: "13px", color: GREEN_DIM, marginBottom: "20px", lineHeight: "1.7" }}>
                  New participants: {counts.new_}<br />
                  Details updates: {counts.updates}<br />
                  Skipped: {counts.skipped}<br />
                  <span style={{ color: counts.problems > 0 ? RED : GREEN_DIM }}>Blocking problems: {counts.problems}</span><br />
                  <span style={{ color: counts.warnings > 0 ? AMBER : GREEN_DIM }}>Warnings: {counts.warnings}</span><br />
                </div>

                {counts.warnings > 0 && (
                  <label style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "13px", color: AMBER, marginBottom: "20px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={isSuspiciousAcknowledged}
                      onChange={(e) => setIsSuspiciousAcknowledged(e.target.checked)}
                      disabled={isImporting}
                    />
                    I reviewed the flagged email addresses and want to continue.
                  </label>
                )}

                {!showConfirmModal ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => setShowConfirmModal(true)}
                      disabled={!isEligible}
                      style={{
                        ...(isEligible ? primaryBtnStyle : secondaryBtnStyle),
                        width: "auto",
                        opacity: isEligible ? 1 : 0.4,
                        cursor: isEligible ? "pointer" : "not-allowed",
                        margin: 0,
                      }}
                    >
                      {manualSource ? "[ CONFIRM PARTICIPANT ]" : "[ CONFIRM IMPORT ]"}
                    </button>
                    {!isEligible && counts.problems > 0 && (
                      <span style={{ fontSize: "12px", color: RED }}>
                        Fix the {counts.problems} blocking {counts.problems === 1 ? "row" : "rows"} before importing.
                      </span>
                    )}
                    {!isEligible && counts.problems === 0 && counts.warnings > 0 && !isSuspiciousAcknowledged && (
                      <span style={{ fontSize: "12px", color: AMBER }}>
                        Review and acknowledge the flagged email addresses before importing.
                      </span>
                    )}
                  </div>
                ) : (
                  <div style={{ padding: "20px", border: `1px solid ${GREEN}`, background: BG, marginTop: "20px" }}>
                    <div style={{ fontSize: "14px", fontWeight: "bold", marginBottom: "16px", color: GREEN }}>{manualSource ? "Save participant?" : "Import roster?"}</div>
                    <div style={{ fontSize: "13px", color: GREEN_DIM, marginBottom: "24px", lineHeight: "1.6" }}>
                      {counts.new_} new participants<br />
                      {counts.updates} details updates<br />
                      {counts.skipped} unchanged/already active<br />
                      <br />
                      This will update the event roster.
                      {counts.warnings > 0 && isSuspiciousAcknowledged && <div style={{ color: AMBER, marginTop: "8px" }}>Flagged addresses acknowledged.</div>}
                    </div>
                    <div style={{ display: "flex", gap: "16px" }}>
                      <button type="button" onClick={() => setShowConfirmModal(false)} disabled={isImporting} style={{ ...secondaryBtnStyle, width: "auto" }}>[ CANCEL ]</button>
                      <button type="button" onClick={handleConfirmImport} disabled={isImporting} style={{ ...primaryBtnStyle, width: "auto", margin: 0 }}>
                        {isImporting ? "[ SAVING... ]" : manualSource ? "[ SAVE PARTICIPANT ]" : "[ IMPORT ROSTER ]"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </SectionBlock>
      )}
    </section>

  );
}

// ---------------------------------------------------------------------------
// Column mapping form
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<RequiredField, string> = {
  name: "Participant Name",
  email: "Email Address",
  branch: "Branch / Department",
};

function MappingForm({
  headers,
  mapping,
  conflicts,
  onUpdate,
}: {
  headers: string[];
  mapping: FieldMapping;
  conflicts: RequiredField[];
  onUpdate: (field: RequiredField, idx: number | null) => void;
}) {
  const id = useId();

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "16px" }}>
      {(["name", "email", "branch"] as RequiredField[]).map((field) => {
        const isConflict = conflicts.includes(field);
        const selectedIdx = mapping[field];
        return (
          <div key={field}>
            <label
              htmlFor={`${id}-${field}`}
              style={{
                display: "block", fontSize: "12px", color: isConflict ? RED : GREEN_DIM,
                letterSpacing: "0.08em", marginBottom: "6px"
              }}
            >
              {FIELD_LABELS[field]} {selectedIdx === null && <span style={{ color: AMBER }}>← required</span>}
            </label>
            <select
              id={`${id}-${field}`}
              value={selectedIdx ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                onUpdate(field, v === "" ? null : parseInt(v, 10));
              }}
              style={{
                width: "100%", fontFamily: MONO, fontSize: "13px",
                background: isConflict ? RED_FAINT : GREEN_GLOW,
                color: isConflict ? RED : GREEN,
                border: `1px solid ${isConflict ? RED : GREY}`,
                padding: "10px 12px", outline: "none",
                appearance: "auto",
              }}
            >
              <option value="">— select column —</option>
              {headers.map((h, idx) => (
                <option key={idx} value={idx}>{h || `(blank column ${idx + 1})`}</option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview results component
// ---------------------------------------------------------------------------

function PreviewResults({ rows, payloadMap }: { rows: PreviewResultRow[]; payloadMap: Record<number, RosterPayloadRow> }) {
  // Summary counts
  const counts = {
    total: rows.length,
    new_: rows.filter((r) => r.category === "NEW").length,
    updates: rows.filter((r) => r.category === "DETAILS_UPDATE").length,
    active: rows.filter((r) => r.category === "ALREADY_ACTIVE").length,
    unchanged: rows.filter((r) => r.category === "UNCHANGED").length,
    problems: rows.filter((r) => r.is_blocking).length,
    warnings: rows.filter((r) => r.is_suspicious_email && !r.is_blocking).length,
  };

  const hasBlocking = counts.problems > 0;

  return (
    <div>
      {/* aria-live region for screen readers */}
      <div aria-live="polite" aria-atomic="true" style={{ position: "absolute", left: "-9999px" }}>
        Preview complete. {counts.total} rows: {counts.new_} new, {counts.problems} problems.
      </div>

      {/* Summary bar */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginBottom: "24px" }}>
        <SummaryChip label="TOTAL" value={counts.total} color={GREEN} />
        <SummaryChip label="NEW" value={counts.new_} color={GREEN} />
        <SummaryChip label="UPDATES" value={counts.updates} color={AMBER} />
        <SummaryChip label="ACTIVE" value={counts.active} color={GREEN_DIM} />
        <SummaryChip label="UNCHANGED" value={counts.unchanged} color={GREEN_DIM} />
        <SummaryChip label="PROBLEMS" value={counts.problems} color={counts.problems > 0 ? RED : GREEN_DIM} />
        <SummaryChip label="WARNINGS" value={counts.warnings} color={counts.warnings > 0 ? AMBER : GREEN_DIM} />
      </div>

      {hasBlocking && (
        <div role="alert" style={{
          background: RED_FAINT, border: `1px solid ${RED}`, padding: "12px 16px",
          fontSize: "13px", color: RED, marginBottom: "20px", lineHeight: "1.7",
          letterSpacing: "0.04em"
        }}>
          ⚠ {counts.problems} row{counts.problems !== 1 ? "s" : ""} must be fixed in the source CSV before import can proceed.
          Fix the issues and re-upload the file.
        </div>
      )}

      {/* Row table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", letterSpacing: "0.02em" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${GREEN_FAINT}` }}>
              {["Row", "Name", "Branch", "Email", "Status", "Details"].map((col) => (
                <th key={col} style={{
                  textAlign: "left", padding: "8px 12px", color: GREEN_DIM,
                  fontWeight: "normal", fontSize: "11px", letterSpacing: "0.12em",
                  whiteSpace: "nowrap"
                }}>
                  {col.toUpperCase()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <PreviewRow key={row.row_number} row={row} payloadRow={payloadMap[row.row_number]} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      border: `1px solid ${color === GREEN ? GREEN_FAINT : "rgba(255,179,71,0.25)"}`,
      padding: "10px 16px", minWidth: "80px", background: GREEN_GLOW
    }}>
      <span style={{ fontSize: "22px", fontWeight: "bold", color, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: "10px", color: GREEN_DIM, letterSpacing: "0.12em", marginTop: "4px" }}>{label}</span>
    </div>
  );
}

// Human-readable category labels
const CATEGORY_LABELS: Record<PreviewCategory, string> = {
  NEW: "New participant",
  UNCHANGED: "Already in roster",
  DETAILS_UPDATE: "Details will be updated",
  ALREADY_ACTIVE: "Already active",
  DUPLICATE_IN_FILE: "Duplicate email",
  INVALID_EMAIL: "Invalid email",
  MISSING_REQUIRED_FIELD: "Missing information",
  CONFLICT: "Cannot process",
};

function categoryColor(cat: PreviewCategory, isBlocking: boolean): string {
  if (isBlocking) return RED;
  if (cat === "NEW") return GREEN;
  if (cat === "DETAILS_UPDATE") return AMBER;
  if (cat === "ALREADY_ACTIVE" || cat === "UNCHANGED") return GREEN_DIM;
  return GREEN_DIM;
}

function PreviewRow({ row, payloadRow }: { row: PreviewResultRow; payloadRow?: RosterPayloadRow }) {
  const rowBg = row.is_blocking ? RED_FAINT : "transparent";
  const catCol = categoryColor(row.category, row.is_blocking);

  const displayName = row.csv_name || payloadRow?.name || "";
  const displayBranch = row.csv_branch || payloadRow?.branch || "";
  const displayEmail = payloadRow?.email || "";

  // Build details cell content
  const detailParts: string[] = [];

  if (row.category === "DETAILS_UPDATE") {
    if (row.db_name && displayName && row.db_name !== displayName) {
      detailParts.push(`Name: ${row.db_name} → ${displayName}`);
    }
    if (row.db_branch !== undefined && displayBranch !== undefined && row.db_branch !== displayBranch) {
      detailParts.push(`Branch: ${row.db_branch ?? "—"} → ${displayBranch ?? "—"}`);
    }
  }

  return (
    <tr style={{ background: rowBg, borderBottom: `1px solid ${GREEN_FAINT}` }}>
      {/* Row number */}
      <td style={{ padding: "10px 12px", color: GREEN_DIM, whiteSpace: "nowrap" }}>
        {row.row_number}
      </td>

      {/* Name */}
      <td style={{ padding: "10px 12px", color: GREEN, maxWidth: "200px", wordBreak: "break-word" }}>
        {displayName || <span style={{ color: RED }}>—</span>}
      </td>

      {/* Branch */}
      <td style={{ padding: "10px 12px", color: GREEN, whiteSpace: "nowrap" }}>
        {displayBranch || <span style={{ color: RED }}>—</span>}
      </td>

      {/* Email */}
      <td style={{ padding: "10px 12px", color: GREEN, maxWidth: "220px", wordBreak: "break-word" }}>
        <span style={row.is_suspicious_email ? { color: AMBER } : {}}>
          {displayEmail || <span style={{ color: RED }}>—</span>}
        </span>
      </td>

      {/* Status */}
      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
        <span style={{ color: catCol, fontWeight: row.is_blocking ? "bold" : "normal" }}>
          {CATEGORY_LABELS[row.category]}
        </span>
        {row.is_suspicious_email && (
          <span style={{ display: "block", color: AMBER, fontSize: "11px", marginTop: "3px" }}>
            ⚠ Check email
          </span>
        )}
      </td>

      {/* Details */}
      <td style={{ padding: "10px 12px", color: GREEN_DIM, fontSize: "12px", maxWidth: "260px" }}>
        {detailParts.length > 0
          ? detailParts.map((d, i) => <div key={i}>{d}</div>)
          : null
        }
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function SectionBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      border: `1px solid ${GREEN_FAINT}`, padding: "24px", marginBottom: "24px",
      background: GREEN_GLOW
    }}>
      <div style={{
        fontSize: "11px", letterSpacing: "0.16em", color: GREEN_DIM,
        marginBottom: "20px", fontWeight: "bold"
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function StatusLine({ text }: { text: string }) {
  return (
    <div style={{ fontSize: "13px", color: GREEN_DIM, letterSpacing: "0.06em", padding: "4px 0" }}>
      &gt;&gt; {text}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" style={{
      background: RED_FAINT, border: `1px solid ${RED}`, padding: "12px 16px",
      fontSize: "13px", color: RED, marginTop: "14px", lineHeight: "1.7",
      letterSpacing: "0.02em"
    }}>
      ✕ {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth sub-views (unchanged from original)
// ---------------------------------------------------------------------------

const primaryBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", gap: "10px",
  width: "100%", padding: "16px 24px", background: GREEN, color: BG, border: "none",
  fontFamily: MONO, fontSize: "13px", fontWeight: "bold", letterSpacing: "0.14em",
  cursor: "pointer", marginBottom: "14px", boxShadow: `0 0 18px ${GREEN_FAINT}`,
};

const secondaryBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", width: "100%",
  padding: "14px 24px", background: "transparent", color: GREEN,
  border: `1px solid ${GREEN}`, fontFamily: MONO, fontSize: "13px",
  fontWeight: "bold", letterSpacing: "0.14em", cursor: "pointer", opacity: 0.75,
};

const statusBarStyle: React.CSSProperties = {
  marginTop: "48px", paddingTop: "16px", borderTop: `1px solid ${GREEN_FAINT}`,
  fontSize: "10px", color: GREEN_DIM, letterSpacing: "0.1em", lineHeight: "1.9", opacity: 0.55,
};

const headingStyle: React.CSSProperties = {
  fontSize: "clamp(38px,11vw,54px)", fontWeight: "bold", color: GREEN, lineHeight: "1.0",
  letterSpacing: "-0.01em", margin: "0 0 20px", textShadow: `0 0 28px ${GREEN_DIM}`,
  fontFamily: MONO,
};

const subtextStyle: React.CSSProperties = {
  fontSize: "14px", color: GREEN_DIM, lineHeight: "1.8", margin: "0 0 40px", letterSpacing: "0.02em",
};

function LoadingView() {
  return (
    <>
      <h1 style={headingStyle}>STAND BY.</h1>
      <p style={subtextStyle}>Establishing secure connection...</p>
      <div style={statusBarStyle}>
        <div>&gt;&gt; CHECKING_SESSION...</div>
        <div>&gt;&gt; PLEASE_WAIT.</div>
      </div>
    </>
  );
}

function LoginView({ onSignIn }: { onSignIn: () => void }) {
  return (
    <>
      <h1 style={headingStyle}>SYSTEM{"\n"}ACCESS.</h1>
      <p style={subtextStyle}>
        Organizer console authentication required.<br />
        Unauthorized access is prohibited.
      </p>
      <button id="btn-admin-google-signin" type="button" style={primaryBtnStyle} onClick={onSignIn}>
        <GoogleIcon />[ CONTINUE WITH GOOGLE ]
      </button>
      <div style={statusBarStyle}>
        <div>&gt;&gt; AUTHENTICATION_REQUIRED...</div>
        <div>&gt;&gt; INITIATING_SECURE_LOGIN...</div>
        <div>&gt;&gt; STANDBY.</div>
      </div>
    </>
  );
}

function DeniedView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <h1 style={headingStyle}>ACCESS{"\n"}DENIED.</h1>
      <p style={subtextStyle}>Your account does not have administrator privileges.</p>
      <button id="btn-admin-denied-sign-out" type="button" style={secondaryBtnStyle} onClick={onSignOut}>
        [ SIGN OUT ]
      </button>
      <div style={statusBarStyle}>
        <div>&gt;&gt; INSUFFICIENT_PRIVILEGES...</div>
        <div>&gt;&gt; ACCESS_DENIED.</div>
      </div>
    </>
  );
}

function ErrorView({
  message, onRetry, onSignOut,
}: { message: string | null; onRetry: () => void; onSignOut: () => void }) {
  return (
    <>
      <h1 style={headingStyle}>TRANSMISSION{"\n"}FAILED.</h1>
      <p style={subtextStyle}>{message ?? "An unexpected error occurred. Please try again."}</p>
      <button id="btn-admin-error-retry" type="button" style={primaryBtnStyle} onClick={onRetry}>[ TRY AGAIN ]</button>
      <button id="btn-admin-error-sign-out" type="button" style={secondaryBtnStyle} onClick={onSignOut}>[ SIGN OUT ]</button>
      <div style={statusBarStyle}>
        <div>&gt;&gt; CONNECTION_FAILED...</div>
        <div>&gt;&gt; RETRY_OR_SIGN_OUT.</div>
      </div>
    </>
  );
}

function GoogleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill={BG} aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}


// ---------------------------------------------------------------------------
// Roster List Component
// ---------------------------------------------------------------------------

function AdminRosterList({
  roster,
  isLoading,
  error,
  onRefresh,
  onPairsChanged
}: {
  roster: AdminParticipantRow[] | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onPairsChanged?: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<AdminParticipantRow[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState('');
  const deletingRef = useRef(false);
  const [pairedMap, setPairedMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let active = true;
    supabase.rpc("admin_list_pairs").then(({ data }) => {
      if (!active || !Array.isArray(data)) return;
      const map = new Map<string, string>();
      for (const p of data) {
        if (p && typeof p === "object") {
          const r = p as Record<string, unknown>;
          if (typeof r.member_a_code === "string" && typeof r.pair_code === "string") {
            map.set(r.member_a_code, r.pair_code);
          }
          if (typeof r.member_b_code === "string" && typeof r.pair_code === "string") {
            map.set(r.member_b_code, r.pair_code);
          }
        }
      }
      setPairedMap(map);
    });
    return () => { active = false; };
  }, [roster]);

  async function confirmDelete() {
    if (!pendingDelete || deletingRef.current) return;
    deletingRef.current = true; setDeleting(true); setDeleteMessage('');
    try {
      const codes = pendingDelete.map(row => row.participant_code);
      const pairedCount = pendingDelete.filter(row => pairedMap.has(row.participant_code)).length;
      const { data, error } = await supabase.rpc('admin_delete_participants', { participant_codes: codes });
      if (error) {
        setDeleteMessage('Deletion could not be confirmed: ' + error.message);
      } else if (!data || data.deleted !== codes.length) {
        setDeleteMessage('Unexpected deletion response. Review the refreshed roster before retrying.');
      } else {
        const pairedNote = pairedCount > 0 ? ' (associated pair dissolved)' : '';
        setDeleteMessage(`${data.deleted} participant${data.deleted === 1 ? '' : 's'} deleted${pairedNote}.`);
      }
    } catch {
      setDeleteMessage('Deletion could not be confirmed. Review the refreshed roster before retrying.');
    } finally {
      setPendingDelete(null); setSelected([]);
      setDeleting(false); deletingRef.current = false;
      onRefresh();
      onPairsChanged?.();
    }
  }
  const [searchQuery, setSearchQuery] = useState("");
  const [branchFilter, setBranchFilter] = useState("ALL");

  if (isLoading && !roster) {
    return <SectionBlock label="ROSTER LIST"><StatusLine text="Loading roster..." /></SectionBlock>;
  }
  if (error) {
    return (
      <SectionBlock label="ROSTER LIST">
        <ErrorBox message={error} />
        <button type="button" onClick={onRefresh} style={{ ...secondaryBtnStyle, width: "auto", marginTop: "16px" }}>
          [ RETRY REFRESH ]
        </button>
      </SectionBlock>
    );
  }
  if (!roster) return null;

  // Compute branches dynamically, excluding null/blank
  const branches = Array.from(new Set(roster.map(r => r.branch).filter((b): b is string => !!b))).sort();

  // Filter logic
  const filtered = roster.filter(r => {
    if (branchFilter !== "ALL" && r.branch !== branchFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      if (!r.name.toLowerCase().includes(q) &&
        !r.registered_email.toLowerCase().includes(q) &&
        !r.participant_code.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });

  const selectedRows = selectedRosterRows(filtered, selected);

  return (
    <section aria-labelledby="roster-list-heading">
      <SectionBlock label="ROSTER LIST">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: "16px", marginBottom: "24px" }}>
          <div style={{ fontSize: "13px", color: GREEN_DIM }}>
            Total Participants: <span style={{ color: GREEN, fontWeight: "bold" }}>{roster.length}</span>
          </div>
          <button type="button" onClick={onRefresh} disabled={isLoading || deleting || !!pendingDelete} style={{ ...secondaryBtnStyle, width: "auto", padding: "8px 16px", fontSize: "11px" }}>
            {isLoading ? "[ REFRESHING... ]" : "[ REFRESH ]"}
          </button>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: "16px", marginBottom: "24px", flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "6px", flex: "1 1 200px" }}>
            <span style={{ fontSize: "11px", color: GREEN_DIM }}>SEARCH</span>
            <input
              type="text"
              placeholder="Name, Email, or ID"
              value={searchQuery}
              disabled={deleting || !!pendingDelete}
              onChange={e => { setSearchQuery(e.target.value); setSelected([]); }}
              style={{
                fontFamily: MONO, fontSize: "13px", color: GREEN,
                background: BG, border: `1px solid ${GREEN_DIM}`,
                padding: "8px 12px", outline: "none"
              }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "6px", flex: "1 1 200px" }}>
            <span style={{ fontSize: "11px", color: GREEN_DIM }}>BRANCH</span>
            <select
              value={branchFilter}
              disabled={deleting || !!pendingDelete}
              onChange={e => { setBranchFilter(e.target.value); setSelected([]); }}
              style={{
                fontFamily: MONO, fontSize: "13px", color: GREEN,
                background: BG, border: `1px solid ${GREEN_DIM}`,
                padding: "8px 12px", outline: "none"
              }}
            >
              <option value="ALL">All branches</option>
              {branches.map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>
        </div>

        {deleteMessage && <p role="status" style={{ lineHeight: 1.7 }}>{deleteMessage}</p>}
        {selectedRows.length > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
          <span>{selectedRows.length} selected</span>
          <button type="button" disabled={deleting || isLoading || !!pendingDelete} style={{ ...secondaryBtnStyle, width: 'auto' }}
            onClick={() => setSelected(filtered.map(row => row.participant_code))}>[ SELECT ALL SHOWN ({filtered.length}) ]</button>
          <button type="button" disabled={deleting || !!pendingDelete} style={{ ...secondaryBtnStyle, width: 'auto' }}
            onClick={() => setSelected([])}>[ CLEAR SELECTION ]</button>
          <button type="button" disabled={deleting || isLoading || !!pendingDelete} style={{ ...secondaryBtnStyle, color: RED, borderColor: RED, width: 'auto' }}
            onClick={() => setPendingDelete(selectedRows)}>[ DELETE SELECTED ]</button>
        </div>}
        {pendingDelete && <DeleteParticipantsDialog participants={pendingDelete} pairedMap={pairedMap} busy={deleting}
          onCancel={() => setPendingDelete(null)} onConfirm={() => { void confirmDelete(); }} />}

        {/* Table */}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", letterSpacing: "0.02em" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${GREEN_FAINT}` }}>
                {["Select", "Participant ID", "Name", "Branch", "Email", "Account", "Actions"].map(col => (
                  <th key={col} style={{ textAlign: "left", padding: "8px 12px", color: GREEN_DIM, fontWeight: "normal", fontSize: "11px" }}>
                    {col.toUpperCase()}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.participant_code} style={{ borderBottom: `1px solid ${GREEN_FAINT}` }}>
                  <td style={{ padding: "10px 12px" }}><input type="checkbox" aria-label={`Select ${r.name} (${r.participant_code})`}
                    checked={selected.includes(r.participant_code)} disabled={deleting || isLoading || !!pendingDelete}
                    onChange={() => setSelected(previous => toggleRosterSelection(previous, r.participant_code))} /></td>
                  <td style={{ padding: "10px 12px", color: GREEN }}>{r.participant_code}</td>
                  <td style={{ padding: "10px 12px", color: GREEN }}>{r.name}</td>
                  <td style={{ padding: "10px 12px", color: GREEN }}>{r.branch || "—"}</td>
                  <td style={{ padding: "10px 12px", color: GREEN }}>{r.registered_email}</td>
                  <td style={{ padding: "10px 12px", color: GREEN_DIM }}>
                    <div>{r.is_linked ? "Linked" : "Not linked"}</div>
                    {pairedMap.has(r.participant_code) && (
                      <div style={{ color: "#ffaa00", fontSize: "11px", marginTop: "3px", fontWeight: "bold" }}>
                        Paired ({pairedMap.get(r.participant_code)})
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "10px 12px" }}><button type="button" aria-label={`Delete ${r.name} (${r.participant_code})`}
                    disabled={deleting || isLoading || !!pendingDelete} onClick={() => setPendingDelete([r])}
                    style={{ ...secondaryBtnStyle, width: 'auto', padding: '8px 12px', color: RED, borderColor: RED }}>[ DELETE ]</button></td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: "20px", textAlign: "center", color: GREEN_DIM }}>
                    No participants found matching filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionBlock>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pair Section
// ---------------------------------------------------------------------------

function validateUnpairedParticipant(item: unknown): UnpairedParticipant | null {
  if (typeof item !== "object" || item === null) return null;
  const r = item as Record<string, unknown>;
  if (typeof r.participant_code !== "string") return null;
  if (typeof r.name !== "string") return null;
  if (r.branch !== null && typeof r.branch !== "string") return null;
  if (typeof r.registered_email !== "string") return null;
  if (typeof r.is_linked !== "boolean") return null;
  return {
    participant_code: r.participant_code,
    name: r.name,
    branch: r.branch ?? null,
    registered_email: r.registered_email,
    is_linked: r.is_linked,
  };
}

function validateAdminPairRow(item: unknown): AdminPairRow | null {
  if (typeof item !== "object" || item === null) return null;
  const r = item as Record<string, unknown>;
  if (typeof r.pair_code !== "string") return null;
  if (typeof r.member_a_code !== "string") return null;
  if (typeof r.member_a_name !== "string") return null;
  if (r.member_a_branch !== null && typeof r.member_a_branch !== "string") return null;
  if (typeof r.member_b_code !== "string") return null;
  if (typeof r.member_b_name !== "string") return null;
  if (r.member_b_branch !== null && typeof r.member_b_branch !== "string") return null;
  return {
    pair_code: r.pair_code,
    member_a_code: r.member_a_code,
    member_a_name: r.member_a_name,
    member_a_branch: r.member_a_branch ?? null,
    member_b_code: r.member_b_code,
    member_b_name: r.member_b_name,
    member_b_branch: r.member_b_branch ?? null,
  };
}

function validateCreatePairResult(data: unknown): CreatePairResult | null {
  if (typeof data !== "object" || data === null) return null;
  const r = data as Record<string, unknown>;
  if (r.success !== true) return null;
  if (typeof r.pair_code !== "string") return null;
  const va = r.member_a as Record<string, unknown> | null;
  const vb = r.member_b as Record<string, unknown> | null;
  if (!va || typeof va.participant_code !== "string" || typeof va.name !== "string") return null;
  if (!vb || typeof vb.participant_code !== "string" || typeof vb.name !== "string") return null;
  return {
    success: true,
    pair_code: r.pair_code,
    member_a: {
      participant_code: va.participant_code,
      name: va.name,
      branch: typeof va.branch === "string" ? va.branch : null,
    },
    member_b: {
      participant_code: vb.participant_code,
      name: vb.name,
      branch: typeof vb.branch === "string" ? vb.branch : null,
    },
  };
}

function participantLabel(p: UnpairedParticipant): string {
  return `${p.participant_code} — ${p.name} — ${p.branch ?? "—"}`;
}

function PairSection({ onPairsChanged, refreshToken }: { onPairsChanged: () => void; refreshToken: number }) {
  const [randomPlan, setRandomPlan] = useState<ReturnType<typeof randomPairPlan<UnpairedParticipant>> | null>(null);
  const [randomMessage, setRandomMessage] = useState('');
  const randomInFlight = useRef(false);

  const [unpaired, setUnpaired] = useState<UnpairedParticipant[] | null>(null);
  const [pairs, setPairs] = useState<AdminPairRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedA, setSelectedA] = useState<string>("");
  const [selectedB, setSelectedB] = useState<string>("");

  const [showConfirm, setShowConfirm] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<CreatePairResult | null>(null);

  const fetchPairState = useCallback(async () => {
    setRandomPlan(null);
    setIsLoading(true);
    setLoadError(null);

    const [{ data: uData, error: uErr }, { data: pData, error: pErr }] = await Promise.all([
      supabase.rpc("admin_list_unpaired_participants"),
      supabase.rpc("admin_list_pairs"),
    ]);

    setIsLoading(false);

    if (uErr || pErr) {
      setLoadError("Failed to load pair state. Check your connection and try again.");
      return;
    }

    if (!Array.isArray(uData) || !Array.isArray(pData)) {
      setLoadError("Unexpected response from server.");
      return;
    }

    const validUnpaired: UnpairedParticipant[] = [];
    for (const item of uData) {
      const v = validateUnpairedParticipant(item);
      if (v) validUnpaired.push(v);
    }

    const validPairs: AdminPairRow[] = [];
    for (const item of pData) {
      const v = validateAdminPairRow(item);
      if (v) validPairs.push(v);
    }

    setUnpaired(validUnpaired);
    setPairs(validPairs);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- Fetch organizer pair state from the server on mount.
    void fetchPairState();
  }, [fetchPairState, refreshToken]);

  async function handleCreatePair() {
    if (!selectedA || !selectedB || selectedA === selectedB || isCreating) return;
    setIsCreating(true);
    setCreateError(null);

    const { data, error } = await supabase.rpc("admin_create_pair_with_puzzle", {
      participant_code_a: selectedA,
      participant_code_b: selectedB,
    });

    setIsCreating(false);
    setShowConfirm(false);

    if (error) {
      console.error(error);
      const msg = error.message?.toLowerCase() ?? "";
      if (msg.includes("unused puzzle")) {
        setCreateError("No unused puzzles remain. Add puzzles in Level 1 before creating more pairs.");
      } else if (msg.includes("already paired")) {
        setCreateError("One or both participants are already paired. The roster may have changed — please choose again.");
      } else if (msg.includes("unknown participant")) {
        setCreateError("One of the participant codes is no longer valid. Refresh and choose again.");
      } else if (msg.includes("permission")) {
        setCreateError("Access denied. Only organizers can create pairs.");
      } else {
        setCreateError("Pair creation failed. No participants were changed. Refresh and try again.");
      }
      // Refresh state to reflect any server-side changes
      setSelectedA("");
      setSelectedB("");
      fetchPairState();
      return;
    }

    const result = validateCreatePairResult(data);
    if (!result) {
      setCreateError("Unexpected response from server. Refresh the pair list to verify state before retrying.");
      setSelectedA("");
      setSelectedB("");
      fetchPairState();
      return;
    }

    setLastCreated(result);
    setSelectedA("");
    setSelectedB("");
    onPairsChanged();
    fetchPairState();
  }

  function previewRandomPairs() {
    if (!unpaired || unpaired.length < 2 || isLoading || isCreating || loadError) return;
    setShowConfirm(false);
    setLastCreated(null);
    setCreateError(null);
    setRandomMessage('');
    setSelectedA(''); setSelectedB('');
    try { setRandomPlan(randomPairPlan(unpaired)); }
    catch { setCreateError('Could not generate pairs. Refresh the participant list.'); }
  }

  async function confirmRandomPairs() {
    if (!randomPlan || randomInFlight.current || isCreating || isLoading || loadError) return;
    randomInFlight.current = true;
    setIsCreating(true);
    setRandomMessage('Creating random pairs…');
    const result = await saveRandomPairs(randomPlan.pairs, async (a, b) => {
      const { data, error } = await supabase.rpc('admin_create_pair_with_puzzle', {
        participant_code_a: a.participant_code, participant_code_b: b.participant_code,
      });
      const confirmed = error ? null : validateCreatePairResult(data);
      if (!confirmed || confirmed.member_a.participant_code !== a.participant_code ||
        confirmed.member_b.participant_code !== b.participant_code) throw new Error('Pair not confirmed');
    });
    setRandomPlan(null);
    setRandomMessage(result.complete
      ? `${result.created} random pairs created with puzzles assigned.${randomPlan.leftover ? ` ${randomPlan.leftover.name} (${randomPlan.leftover.participant_code}) remains unpaired.` : ''}`
      : `${result.created} pairs confirmed. Stopped because the next pair could not be confirmed. Review the refreshed list and available puzzle count before generating another preview.`);
    if (result.created > 0) onPairsChanged();
    try { await fetchPairState(); }
    catch { setIsLoading(false); setLoadError('Could not refresh pairs. Refresh before trying again.'); }
    finally { randomInFlight.current = false; setIsCreating(false); }
  }

  const canCreate = selectedA !== "" && selectedB !== "" && selectedA !== selectedB && !isCreating && !isLoading && !loadError && !randomPlan;

  const participantA = unpaired?.find(p => p.participant_code === selectedA) ?? null;
  const participantB = unpaired?.find(p => p.participant_code === selectedB) ?? null;

  return (
    <section aria-labelledby="pair-section-heading" style={{ marginTop: "48px" }}>
      <h2 id="pair-section-heading" style={{
        fontSize: "13px", letterSpacing: "0.16em",
        color: GREEN_DIM, marginBottom: "28px", fontWeight: "normal"
      }}>
        &gt;&gt; SECTION: PAIR_ASSIGNMENT
      </h2>

      <SectionBlock label="06  PAIR ASSIGNMENT">
        {/* Summary */}
        <div style={{ display: "flex", gap: "24px", marginBottom: "24px", flexWrap: "wrap" }}>
          <div style={{ fontSize: "13px", color: GREEN_DIM }}>
            Unpaired participants:{" "}
            <span style={{ color: GREEN, fontWeight: "bold" }}>
              {unpaired === null ? "—" : unpaired.length}
            </span>
          </div>
          <div style={{ fontSize: "13px", color: GREEN_DIM }}>
            Created pairs:{" "}
            <span style={{ color: GREEN, fontWeight: "bold" }}>
              {pairs === null ? "—" : pairs.length}
            </span>
          </div>
          <button
            type="button"
            onClick={fetchPairState}
            disabled={isLoading || isCreating}
            style={{ ...secondaryBtnStyle, width: "auto", padding: "6px 14px", fontSize: "11px", margin: 0 }}
          >
            {isLoading ? "[ REFRESHING... ]" : "[ REFRESH ]"}
          </button>
        </div>

        {loadError && <ErrorBox message={loadError} />}

        {/* Last created success message */}
        {lastCreated && (
          <div style={{
            padding: "16px", border: `1px solid ${GREEN}`, marginBottom: "24px",
            background: GREEN_GLOW, fontSize: "13px", lineHeight: "1.8"
          }}>
            <div style={{ color: GREEN, fontWeight: "bold", marginBottom: "8px" }}>
              {lastCreated.pair_code} CREATED — PUZZLE ASSIGNED
            </div>
            <div style={{ color: GREEN_DIM }}>
              Fragment A — {lastCreated.member_a.participant_code} — {lastCreated.member_a.name} — {lastCreated.member_a.branch ?? "—"}
            </div>
            <div style={{ color: GREEN_DIM }}>
              Fragment B — {lastCreated.member_b.participant_code} — {lastCreated.member_b.name} — {lastCreated.member_b.branch ?? "—"}
            </div>
          </div>
        )}

        <button type="button" onClick={previewRandomPairs}
          disabled={isCreating || isLoading || !!loadError || !unpaired || unpaired.length < 2}
          style={{ ...secondaryBtnStyle, width: "auto", marginBottom: 16 }}>
          [ RANDOMLY PAIR ]
        </button>
        <p style={{ fontSize: 13, color: GREEN_DIM }}>Randomly pair all currently unpaired participants and assign each an unused puzzle. Existing pairs stay unchanged.</p>
        {randomMessage && <p role="status" style={{ lineHeight: 1.7 }}>{randomMessage}</p>}
        {randomPlan && <div style={{ border: `1px solid ${GREEN_DIM}`, padding: 16, marginBottom: 24 }}>
          <h3 style={{ fontSize: 14 }}>REVIEW {randomPlan.pairs.length} RANDOM PAIRS</h3>
          <ol style={{ paddingLeft: 24, lineHeight: 1.8, overflowWrap: 'anywhere' }}>
            {randomPlan.pairs.map(([a, b]) => <li key={a.participant_code}>
              A: {a.name} ({a.participant_code}) ↔ B: {b.name} ({b.participant_code})
            </li>)}
          </ol>
          {randomPlan.leftover && <p>Remains unpaired: {randomPlan.leftover.name} ({randomPlan.leftover.participant_code}).</p>}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button type="button" disabled={isCreating} onClick={() => setRandomPlan(null)}
              style={{ ...secondaryBtnStyle, width: 'auto' }}>[ CANCEL ]</button>
            <button type="button" disabled={isCreating} onClick={() => { void confirmRandomPairs(); }}
              style={{ ...primaryBtnStyle, width: 'auto', margin: 0 }}>
              {isCreating ? '[ CREATING PAIRS… ]' : '[ CONFIRM RANDOM PAIRS ]'}
            </button>
          </div>
        </div>}

        {/* Participant selectors */}
        {unpaired !== null && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "20px", marginBottom: "24px" }}>
            {/* Fragment A */}
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "11px", color: GREEN_DIM, letterSpacing: "0.08em" }}>
                FRAGMENT A PARTICIPANT
              </span>
              <select
                id="pair-select-a"
                value={selectedA}
                onChange={e => { setSelectedA(e.target.value); setShowConfirm(false); setLastCreated(null); setCreateError(null); }}
                disabled={isCreating || !!randomPlan}
                style={{
                  fontFamily: MONO, fontSize: "13px", color: GREEN,
                  background: BG, border: `1px solid ${GREY}`,
                  padding: "10px 12px", outline: "none", appearance: "auto",
                }}
              >
                <option value="">— select participant —</option>
                {unpaired
                  .filter(p => p.participant_code !== selectedB)
                  .map(p => (
                    <option key={p.participant_code} value={p.participant_code}>
                      {participantLabel(p)}
                    </option>
                  ))}
              </select>
            </label>

            {/* Fragment B */}
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "11px", color: GREEN_DIM, letterSpacing: "0.08em" }}>
                FRAGMENT B PARTICIPANT
              </span>
              <select
                id="pair-select-b"
                value={selectedB}
                onChange={e => { setSelectedB(e.target.value); setShowConfirm(false); setLastCreated(null); setCreateError(null); }}
                disabled={isCreating || !!randomPlan}
                style={{
                  fontFamily: MONO, fontSize: "13px", color: GREEN,
                  background: BG, border: `1px solid ${GREY}`,
                  padding: "10px 12px", outline: "none", appearance: "auto",
                }}
              >
                <option value="">— select participant —</option>
                {unpaired
                  .filter(p => p.participant_code !== selectedA)
                  .map(p => (
                    <option key={p.participant_code} value={p.participant_code}>
                      {participantLabel(p)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}

        {unpaired !== null && unpaired.length < 2 && (
          <div style={{ fontSize: "12px", color: GREEN_DIM, marginBottom: "20px" }}>
            At least 2 unpaired participants are required to create a pair.
          </div>
        )}

        {createError && <ErrorBox message={createError} />}

        {/* Create button / confirmation */}
        {!showConfirm ? (
          <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
            <button
              id="btn-create-pair"
              type="button"
              onClick={() => { setShowConfirm(true); setLastCreated(null); setCreateError(null); }}
              disabled={!canCreate}
              style={{
                ...(canCreate ? primaryBtnStyle : secondaryBtnStyle),
                width: "auto",
                opacity: canCreate ? 1 : 0.4,
                cursor: canCreate ? "pointer" : "not-allowed",
                margin: 0,
              }}
            >
              [ CREATE PAIR ]
            </button>
            {!canCreate && selectedA === "" && selectedB === "" && unpaired !== null && unpaired.length >= 2 && (
              <span style={{ fontSize: "12px", color: GREEN_DIM }}>
                Select Fragment A and Fragment B participants.
              </span>
            )}
          </div>
        ) : (
          participantA && participantB && (
            <div style={{ padding: "20px", border: `1px solid ${GREEN}`, background: BG, marginTop: "4px" }}>
              <div style={{ fontSize: "14px", fontWeight: "bold", marginBottom: "16px", color: GREEN }}>
                Create pair?
              </div>
              <div style={{ fontSize: "13px", color: GREEN_DIM, marginBottom: "24px", lineHeight: "1.8" }}>
                <div>Fragment A: <span style={{ color: GREEN }}>{participantA.participant_code} — {participantA.name} — {participantA.branch ?? "—"}</span></div>
                <div>Fragment B: <span style={{ color: GREEN }}>{participantB.participant_code} — {participantB.name} — {participantB.branch ?? "—"}</span></div>
              </div>
              <div style={{ display: "flex", gap: "16px" }}>
                <button
                  type="button"
                  onClick={() => setShowConfirm(false)}
                  disabled={isCreating}
                  style={{ ...secondaryBtnStyle, width: "auto" }}
                >
                  [ CANCEL ]
                </button>
                <button
                  id="btn-confirm-create-pair"
                  type="button"
                  onClick={handleCreatePair}
                  disabled={isCreating}
                  style={{ ...primaryBtnStyle, width: "auto", margin: 0 }}
                >
                  {isCreating ? "[ CREATING PAIR... ]" : "[ CREATE PAIR ]"}
                </button>
              </div>
            </div>
          )
        )}
      </SectionBlock>

      {/* Pair list */}
      <SectionBlock label="07  PAIR LIST">
        {pairs === null || isLoading ? (
          <StatusLine text={isLoading ? "Loading pairs..." : "No pair data."} />
        ) : pairs.length === 0 ? (
          <div style={{ fontSize: "13px", color: GREEN_DIM }}>
            No pairs created yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${GREEN_FAINT}` }}>
                  {["PAIR", "FRAGMENT A", "FRAGMENT B"].map(col => (
                    <th key={col} style={{
                      textAlign: "left", padding: "8px 12px", color: GREEN_DIM,
                      fontWeight: "normal", fontSize: "11px", letterSpacing: "0.08em"
                    }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pairs.map(p => (
                  <tr key={p.pair_code} style={{ borderBottom: `1px solid ${GREEN_FAINT}` }}>
                    <td style={{ padding: "10px 12px", color: GREEN, fontWeight: "bold" }}>{p.pair_code}</td>
                    <td style={{ padding: "10px 12px", color: GREEN }}>
                      {p.member_a_code} — {p.member_a_name} — {p.member_a_branch ?? "—"}
                    </td>
                    <td style={{ padding: "10px 12px", color: GREEN }}>
                      {p.member_b_code} — {p.member_b_name} — {p.member_b_branch ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionBlock>
    </section>
  );
}
