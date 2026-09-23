import { useState, useEffect } from "react";
import { supabase } from "../../lib/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AdminStatus =
  | "loading"
  | "unauthenticated"
  | "is_admin"
  | "not_admin"
  | "error";

// ---------------------------------------------------------------------------
// Design tokens (inline — keeps this a single self-contained file)
// ---------------------------------------------------------------------------

const GREEN = "#39ff14";
const GREEN_DIM = "rgba(57,255,20,0.55)";
const GREEN_FAINT = "rgba(57,255,20,0.12)";
const BG = "#050905";

const s = {
  page: {
    background: BG,
    minHeight: "100svh",
    flex: "1",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "32px 24px",
    fontFamily: "'Courier New', Courier, monospace",
    color: GREEN,
    boxSizing: "border-box" as const,
  },
  card: {
    width: "100%",
    maxWidth: "420px",
    display: "flex",
    flexDirection: "column" as const,
  },
  siteLabel: {
    fontSize: "11px",
    letterSpacing: "0.18em",
    color: GREEN_DIM,
    marginBottom: "40px",
    lineHeight: "1.8",
  },
  heading: {
    fontSize: "clamp(38px,11vw,54px)",
    fontWeight: "bold",
    color: GREEN,
    lineHeight: "1.0",
    letterSpacing: "-0.01em",
    margin: "0 0 20px",
    textShadow: `0 0 28px ${GREEN_DIM}`,
  },
  subtext: {
    fontSize: "14px",
    color: GREEN_DIM,
    lineHeight: "1.8",
    margin: "0 0 40px",
    letterSpacing: "0.02em",
  },
  primaryBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    width: "100%",
    padding: "16px 24px",
    background: GREEN,
    color: BG,
    border: "none",
    fontFamily: "'Courier New', Courier, monospace",
    fontSize: "13px",
    fontWeight: "bold",
    letterSpacing: "0.14em",
    cursor: "pointer",
    marginBottom: "14px",
    boxShadow: `0 0 18px ${GREEN_FAINT}`,
  },
  secondaryBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    padding: "14px 24px",
    background: "transparent",
    color: GREEN,
    border: `1px solid ${GREEN}`,
    fontFamily: "'Courier New', Courier, monospace",
    fontSize: "13px",
    fontWeight: "bold",
    letterSpacing: "0.14em",
    cursor: "pointer",
    opacity: 0.75,
  },
  statusBar: {
    marginTop: "48px",
    paddingTop: "16px",
    borderTop: `1px solid ${GREEN_FAINT}`,
    fontSize: "10px",
    color: GREEN_DIM,
    letterSpacing: "0.1em",
    lineHeight: "1.9",
    opacity: 0.55,
  },
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AdminHome() {
  const [status, setStatus] = useState<AdminStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Match the body background to our terminal theme
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = BG;
    return () => {
      document.body.style.background = prev;
    };
  }, []);

  // On mount: check for an existing session and admin status if found
  useEffect(() => {
    checkSessionAndAdminStatus();
  }, []);

  async function checkSessionAndAdminStatus() {
    setStatus("loading");
    setErrorMessage(null);

    const { data: { session }, error: sessionError } =
      await supabase.auth.getSession();

    if (sessionError || !session) {
      setStatus("unauthenticated");
      return;
    }

    await performAdminCheck();
  }

  async function performAdminCheck() {
    setStatus("loading");
    setErrorMessage(null);

    const { data, error: rpcError } = await supabase.rpc("check_admin_status");

    if (rpcError) {
      console.error("check_admin_status:", rpcError.message);
      setErrorMessage(
        "Could not reach the server. Check your connection and try again."
      );
      setStatus("error");
      return;
    }

    const result = data as string | null;

    if (result === "IS_ADMIN") {
      setStatus("is_admin");
    } else if (result === "NOT_ADMIN") {
      setStatus("not_admin");
    } else {
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

    if (error) {
      console.error("Google sign-in failed:", error.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.siteLabel}>
          MEC.CONF 2026&nbsp;&nbsp;//&nbsp;&nbsp;ADMIN
        </div>

        {status === "loading" && <LoadingView />}

        {status === "unauthenticated" && (
          <LoginView onSignIn={handleGoogleSignIn} />
        )}

        {status === "is_admin" && (
          <DashboardShellView onSignOut={handleSignOut} />
        )}

        {status === "not_admin" && <DeniedView onSignOut={handleSignOut} />}

        {status === "error" && (
          <ErrorView
            message={errorMessage}
            onRetry={performAdminCheck}
            onSignOut={handleSignOut}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local sub-views
// ---------------------------------------------------------------------------

function LoadingView() {
  return (
    <>
      <h1 style={s.heading}>STAND BY.</h1>
      <p style={s.subtext}>Establishing secure connection...</p>
      <div style={s.statusBar}>
        <div>&gt;&gt; CHECKING_SESSION...</div>
        <div>&gt;&gt; PLEASE_WAIT.</div>
      </div>
    </>
  );
}

function LoginView({ onSignIn }: { onSignIn: () => void }) {
  return (
    <>
      <h1 style={s.heading}>SYSTEM{"\n"}ACCESS.</h1>
      <p style={s.subtext}>
        Organizer console authentication required.
        <br />
        Unauthorized access is prohibited.
      </p>

      <button
        id="btn-admin-google-signin"
        type="button"
        style={s.primaryBtn}
        onClick={onSignIn}
      >
        <GoogleIcon />[ CONTINUE WITH GOOGLE ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; AUTHENTICATION_REQUIRED...</div>
        <div>&gt;&gt; INITIATING_SECURE_LOGIN...</div>
        <div>&gt;&gt; STANDBY.</div>
      </div>
    </>
  );
}

function DashboardShellView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <h1 style={s.heading}>ADMIN ACCESS{"\n"}CONFIRMED.</h1>
      <p style={s.subtext}>
        Organizer console.
        <br />
        Roster management coming next.
      </p>

      <button
        id="btn-admin-sign-out"
        type="button"
        style={s.secondaryBtn}
        onClick={onSignOut}
      >
        [ SIGN OUT ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; SYSTEM_ONLINE...</div>
        <div>&gt;&gt; WAITING_FOR_COMMANDS.</div>
      </div>
    </>
  );
}

function DeniedView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <h1 style={s.heading}>ACCESS{"\n"}DENIED.</h1>
      <p style={s.subtext}>
        Your account does not have administrator privileges.
      </p>

      <button
        id="btn-admin-denied-sign-out"
        type="button"
        style={s.secondaryBtn}
        onClick={onSignOut}
      >
        [ SIGN OUT ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; INSUFFICIENT_PRIVILEGES...</div>
        <div>&gt;&gt; ACCESS_DENIED.</div>
      </div>
    </>
  );
}

function ErrorView({
  message,
  onRetry,
  onSignOut,
}: {
  message: string | null;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  return (
    <>
      <h1 style={s.heading}>TRANSMISSION{"\n"}FAILED.</h1>
      <p style={s.subtext}>
        {message ?? "An unexpected error occurred. Please try again."}
      </p>

      <button
        id="btn-admin-error-retry"
        type="button"
        style={s.primaryBtn}
        onClick={onRetry}
      >
        [ TRY AGAIN ]
      </button>

      <button
        id="btn-admin-error-sign-out"
        type="button"
        style={s.secondaryBtn}
        onClick={onSignOut}
      >
        [ SIGN OUT ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; CONNECTION_FAILED...</div>
        <div>&gt;&gt; RETRY_OR_SIGN_OUT.</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function GoogleIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill={BG}
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}
