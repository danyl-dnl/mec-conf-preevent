import { useState, useEffect } from "react";
import { supabase } from "../../lib/supabase";

const GREEN       = "#39ff14";
const GREEN_DIM   = "rgba(57,255,20,0.55)";
const GREEN_FAINT = "rgba(57,255,20,0.12)";
const GREEN_GLOW  = "rgba(57,255,20,0.08)";
const BG          = "#050905";
const RED         = "#ff4444";
const RED_FAINT   = "rgba(255,68,68,0.12)";
const AMBER       = "#ffb347";
const MONO        = "'Courier New', Courier, monospace";

export interface AdminMember {
  email: string;
  created_at: string;
  status: "ACTIVE" | "PENDING_LOGIN";
  is_current_user: boolean;
  last_sign_in_at: string | null;
}

export default function AdminManagement() {
  const [admins, setAdmins] = useState<AdminMember[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [newEmail, setNewEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Deletion state
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  useEffect(() => {
    fetchAdmins();
  }, []);

  async function fetchAdmins() {
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: rpcErr } = await supabase.rpc("admin_list_admins");
      if (rpcErr) {
        setError(rpcErr.message);
      } else if (Array.isArray(data)) {
        setAdmins(data as AdminMember[]);
      }
    } catch (e: any) {
      setError(e.message || "Failed to load admin team");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleAddAdmin(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSuccessMsg(null);

    const email = newEmail.trim().toLowerCase();
    if (!email) {
      setFormError("Please enter an email address.");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError("Please enter a valid email format (e.g. organizer@mec.ac.in).");
      return;
    }

    if (admins.some(a => a.email.toLowerCase() === email)) {
      setFormError(`"${email}" is already an administrator.`);
      return;
    }

    setIsSubmitting(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc("admin_add_admin", { target_email: email });
      if (rpcErr) {
        setFormError(rpcErr.message);
      } else {
        const result = data as { success: boolean; email: string; status: string };
        if (result.status === "ACTIVE") {
          setSuccessMsg(`✓ Added ${email} as an active administrator.`);
        } else {
          setSuccessMsg(`✓ Added ${email} to admin allowlist. They will have full access once they log in with Google.`);
        }
        setNewEmail("");
        await fetchAdmins();
      }
    } catch (e: any) {
      setFormError(e.message || "Failed to add administrator.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function confirmRemoveAdmin(email: string) {
    setIsRemoving(true);
    setFormError(null);
    setSuccessMsg(null);
    try {
      const { error: rpcErr } = await supabase.rpc("admin_remove_admin", { target_email: email });
      if (rpcErr) {
        setFormError(rpcErr.message);
      } else {
        setSuccessMsg(`✓ Removed administrator privileges for ${email}.`);
        setPendingRemove(null);
        await fetchAdmins();
      }
    } catch (e: any) {
      setFormError(e.message || "Failed to remove administrator.");
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <section aria-labelledby="admin-team-heading" style={{ marginBottom: "36px" }}>
      <h2
        id="admin-team-heading"
        style={{
          fontSize: "13px",
          letterSpacing: "0.16em",
          color: GREEN_DIM,
          marginBottom: "20px",
          fontWeight: "normal",
        }}
      >
        &gt;&gt; SECTION: ADMINISTRATOR_ACCESS_CONTROL
      </h2>

      <div
        style={{
          border: `1px solid ${GREEN_FAINT}`,
          padding: "24px",
          marginBottom: "24px",
          background: GREEN_GLOW,
        }}
      >
        <div
          style={{
            fontSize: "11px",
            letterSpacing: "0.16em",
            color: GREEN_DIM,
            marginBottom: "16px",
            fontWeight: "bold",
          }}
        >
          ADD NEW ADMINISTRATOR
        </div>

        <form onSubmit={handleAddAdmin} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", flexGrow: 1, minWidth: "260px" }}>
              <span style={{ fontSize: "11px", color: GREEN_DIM, letterSpacing: "0.08em" }}>
                Admin Google Account Email:
              </span>
              <input
                id="input-new-admin-email"
                type="email"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                placeholder="e.g. organizer@mec.ac.in"
                disabled={isSubmitting}
                style={{
                  background: BG,
                  border: `1px solid ${GREEN}`,
                  color: GREEN,
                  fontFamily: MONO,
                  fontSize: "13px",
                  padding: "10px 14px",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </label>

            <button
              id="btn-add-admin"
              type="submit"
              disabled={isSubmitting || !newEmail.trim()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: newEmail.trim() ? GREEN : "transparent",
                color: newEmail.trim() ? BG : GREEN_DIM,
                border: `1px solid ${GREEN}`,
                fontFamily: MONO,
                fontSize: "12px",
                fontWeight: "bold",
                letterSpacing: "0.12em",
                padding: "11px 20px",
                cursor: newEmail.trim() && !isSubmitting ? "pointer" : "not-allowed",
                boxSizing: "border-box",
                opacity: isSubmitting ? 0.6 : 1,
              }}
            >
              {isSubmitting ? "[ ADDING... ]" : "[ + ADD ADMIN ]"}
            </button>
          </div>

          <div style={{ fontSize: "11px", color: GREEN_DIM, lineHeight: "1.6" }}>
            Authorized emails can sign in using their Google account at the Admin portal.
            If they have not signed in yet, they will be granted immediate admin rights on first login.
          </div>

          {formError && (
            <div
              role="alert"
              style={{
                background: RED_FAINT,
                border: `1px solid ${RED}`,
                color: RED,
                padding: "10px 14px",
                fontSize: "12px",
                fontFamily: MONO,
              }}
            >
              ✕ {formError}
            </div>
          )}

          {successMsg && (
            <div
              role="status"
              style={{
                background: GREEN_FAINT,
                border: `1px solid ${GREEN}`,
                color: GREEN,
                padding: "10px 14px",
                fontSize: "12px",
                fontFamily: MONO,
              }}
            >
              {successMsg}
            </div>
          )}
        </form>
      </div>

      {/* Admin List */}
      <div
        style={{
          border: `1px solid ${GREEN_FAINT}`,
          padding: "24px",
          background: GREEN_GLOW,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "16px",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div style={{ fontSize: "11px", letterSpacing: "0.16em", color: GREEN_DIM, fontWeight: "bold" }}>
            AUTHORIZED ADMINISTRATORS ({admins.length})
          </div>
          <button
            type="button"
            onClick={fetchAdmins}
            disabled={isLoading}
            style={{
              background: "transparent",
              color: GREEN,
              border: `1px solid ${GREEN_FAINT}`,
              fontFamily: MONO,
              fontSize: "11px",
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            {isLoading ? "[ REFRESHING... ]" : "[ REFRESH LIST ]"}
          </button>
        </div>

        {error && (
          <div
            role="alert"
            style={{
              background: RED_FAINT,
              border: `1px solid ${RED}`,
              color: RED,
              padding: "10px 14px",
              fontSize: "12px",
              marginBottom: "14px",
            }}
          >
            ✕ {error}
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: MONO, fontSize: "12px" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${GREEN_FAINT}`, textAlign: "left", color: GREEN_DIM }}>
                <th style={{ padding: "10px 12px", fontWeight: "normal" }}>EMAIL</th>
                <th style={{ padding: "10px 12px", fontWeight: "normal" }}>STATUS</th>
                <th style={{ padding: "10px 12px", fontWeight: "normal" }}>ADDED AT</th>
                <th style={{ padding: "10px 12px", fontWeight: "normal", textAlign: "right" }}>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {admins.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={4} style={{ padding: "20px 12px", color: GREEN_DIM, textAlign: "center" }}>
                    No administrators found.
                  </td>
                </tr>
              )}
              {admins.map(admin => {
                const isPending = admin.status === "PENDING_LOGIN";
                return (
                  <tr
                    key={admin.email}
                    style={{
                      borderBottom: `1px solid rgba(57,255,20,0.06)`,
                      background: admin.is_current_user ? "rgba(57,255,20,0.04)" : "transparent",
                    }}
                  >
                    <td style={{ padding: "12px", color: GREEN }}>
                      {admin.email}
                      {admin.is_current_user && (
                        <span
                          style={{
                            marginLeft: "8px",
                            fontSize: "10px",
                            padding: "2px 6px",
                            background: GREEN_FAINT,
                            border: `1px solid ${GREEN}`,
                            color: GREEN,
                          }}
                        >
                          YOU
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "12px" }}>
                      <span
                        style={{
                          fontSize: "11px",
                          letterSpacing: "0.06em",
                          padding: "3px 8px",
                          border: `1px solid ${isPending ? AMBER : GREEN}`,
                          color: isPending ? AMBER : GREEN,
                          background: isPending ? "rgba(255,179,71,0.08)" : GREEN_FAINT,
                        }}
                      >
                        {isPending ? "PENDING LOGIN" : "ACTIVE"}
                      </span>
                    </td>
                    <td style={{ padding: "12px", color: GREEN_DIM, fontSize: "11px" }}>
                      {admin.created_at ? new Date(admin.created_at).toLocaleDateString() : "—"}
                    </td>
                    <td style={{ padding: "12px", textAlign: "right" }}>
                      {admin.is_current_user ? (
                        <span style={{ fontSize: "11px", color: GREEN_DIM }}>—</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPendingRemove(admin.email)}
                          disabled={isRemoving}
                          style={{
                            background: "transparent",
                            border: `1px solid ${RED}`,
                            color: RED,
                            fontFamily: MONO,
                            fontSize: "11px",
                            padding: "4px 10px",
                            cursor: "pointer",
                          }}
                        >
                          [ REMOVE ]
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Confirmation Dialog for Removing Admin */}
      {pendingRemove && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm Admin Removal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "20px",
          }}
        >
          <div
            style={{
              background: BG,
              border: `1px solid ${RED}`,
              padding: "28px",
              maxWidth: "460px",
              width: "100%",
              fontFamily: MONO,
              boxShadow: `0 0 30px ${RED_FAINT}`,
            }}
          >
            <div style={{ color: RED, fontSize: "14px", fontWeight: "bold", marginBottom: "16px", letterSpacing: "0.1em" }}>
              CONFIRM ADMIN REMOVAL
            </div>
            <div style={{ color: GREEN, fontSize: "13px", lineHeight: "1.7", marginBottom: "20px" }}>
              Are you sure you want to revoke administrator access for:
              <br />
              <strong style={{ color: AMBER }}>{pendingRemove}</strong>?
              <br />
              <span style={{ fontSize: "11px", color: GREEN_DIM }}>
                They will no longer be able to access the admin console or manage participants.
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
              <button
                type="button"
                onClick={() => setPendingRemove(null)}
                disabled={isRemoving}
                style={{
                  background: "transparent",
                  border: `1px solid ${GREEN_DIM}`,
                  color: GREEN_DIM,
                  fontFamily: MONO,
                  fontSize: "12px",
                  padding: "8px 16px",
                  cursor: "pointer",
                }}
              >
                [ CANCEL ]
              </button>
              <button
                type="button"
                onClick={() => confirmRemoveAdmin(pendingRemove)}
                disabled={isRemoving}
                style={{
                  background: RED,
                  border: "none",
                  color: "#000",
                  fontFamily: MONO,
                  fontSize: "12px",
                  fontWeight: "bold",
                  padding: "8px 18px",
                  cursor: isRemoving ? "not-allowed" : "pointer",
                }}
              >
                {isRemoving ? "[ REVOKING... ]" : "[ REVOKE ACCESS ]"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
