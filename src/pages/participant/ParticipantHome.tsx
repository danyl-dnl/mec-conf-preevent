import { useState, useEffect } from "react";
import { supabase } from "../../lib/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of our own row from the participants table */
interface ParticipantProfile {
  id: string;
  participant_code: string;
  name: string;
  registered_email: string;
}

/**
 * All states the page can be in.
 *
 * loading         — checking session or calling RPC
 * unauthenticated — no session → show login button
 * linked          — LINKED or ALREADY_LINKED → show participant info
 * not_registered  — NOT_REGISTERED → not on the approved roster
 * denied          — LINKING_DENIED → account/identity conflict
 * error           — network failure or unexpected server response
 */
type LinkStatus =
  | "loading"
  | "unauthenticated"
  | "linked"
  | "not_registered"
  | "denied"
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
  disclaimer: {
    fontSize: "11px",
    color: GREEN_DIM,
    letterSpacing: "0.06em",
    marginTop: "18px",
    lineHeight: "1.7",
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
  infoBox: {
    border: `1px solid ${GREEN_FAINT}`,
    padding: "20px 20px 16px",
    marginBottom: "28px",
    background: "rgba(57,255,20,0.03)",
  },
  infoLabel: {
    fontSize: "10px",
    letterSpacing: "0.18em",
    color: GREEN_DIM,
    marginBottom: "5px",
  },
  infoValue: {
    fontSize: "20px",
    color: GREEN,
    fontWeight: "bold",
    letterSpacing: "0.04em",
    marginBottom: "18px",
  },
  dot: {
    display: "inline-block",
    width: "6px",
    height: "6px",
    background: GREEN,
    borderRadius: "50%",
    marginRight: "8px",
    verticalAlign: "middle",
    boxShadow: `0 0 6px ${GREEN}`,
  },
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ParticipantHome() {
  const [status, setStatus] = useState<LinkStatus>("loading");
  const [profile, setProfile] = useState<ParticipantProfile | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Match the body background to our terminal theme
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = BG;
    return () => {
      document.body.style.background = prev;
    };
  }, []);

  // On mount: check for an existing session and link if found
  useEffect(() => {
    checkSessionAndLink();
  }, []);

  /**
   * Check whether the user already has a Supabase session.
   * If yes, proceed to call the RPC.
   * If no, show the login button.
   */
  async function checkSessionAndLink() {
    setStatus("loading");

    const { data: { session }, error: sessionError } =
      await supabase.auth.getSession();

    if (sessionError || !session) {
      setStatus("unauthenticated");
      return;
    }

    await performLinking();
  }

  /**
   * Call link_current_participant() and handle every possible result.
   *
   * The RPC takes zero arguments — the database derives the caller
   * exclusively from auth.uid(). We never send any identity information
   * from the frontend.
   */
  async function performLinking() {
    setStatus("loading");
    setErrorMessage(null);

    const { data, error: rpcError } = await supabase.rpc(
      "link_current_participant",
    );

    if (rpcError) {
      // Network failure or unexpected server error — not an auth denial
      console.error("link_current_participant:", rpcError.message);
      setErrorMessage(
        "Could not reach the server. Check your connection and try again.",
      );
      setStatus("error");
      return;
    }

    const result = data as string | null;

    if (result === "LINKED" || result === "ALREADY_LINKED") {
      // The account is linked. Fetch our own row via RLS.
      // RLS ensures we can only read our own participant row.
      const { data: row, error: fetchError } = await supabase
        .from("participants")
        .select("id, participant_code, name, registered_email")
        .single();

      if (fetchError || !row) {
        console.error("Profile fetch failed:", fetchError?.message);
        setErrorMessage(
          "Your account was linked but your profile could not be loaded. Try refreshing the page.",
        );
        setStatus("error");
        return;
      }

      setProfile(row as ParticipantProfile);
      setStatus("linked");
    } else if (result === "NOT_REGISTERED") {
      // Authenticated, but the email is not on the approved roster
      setStatus("not_registered");
    } else if (result === "LINKING_DENIED") {
      // Identity/account conflict — we intentionally do not expose details
      setStatus("denied");
    } else {
      // Unexpected/unknown response from the server
      setErrorMessage("An unexpected response was received. Please try again.");
      setStatus("error");
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setProfile(null);
    setErrorMessage(null);
    setStatus("unauthenticated");
  }

  async function handleGoogleSignIn() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
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
          MEC.CONF 2026&nbsp;&nbsp;//&nbsp;&nbsp;PRE-EVENT
        </div>

        {status === "loading" && <LoadingView />}

        {status === "unauthenticated" && (
          <LoginView onSignIn={handleGoogleSignIn} />
        )}

        {status === "linked" && profile && (
          <ProfileView profile={profile} onSignOut={handleSignOut} />
        )}

        {status === "not_registered" && (
          <NotRegisteredView onSignOut={handleSignOut} />
        )}

        {status === "denied" && <DeniedView onSignOut={handleSignOut} />}

        {status === "error" && (
          <ErrorView
            message={errorMessage}
            onRetry={performLinking}
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
      <h1 style={s.heading}>YOUR HALF{"\n"}AWAITS.</h1>
      <p style={s.subtext}>
        One puzzle. Two fragments.
        <br />
        Find your partner. Solve together.
      </p>

      <button id="btn-google-signin" type="button" style={s.primaryBtn} onClick={onSignIn}>
        <GoogleIcon />[ CONTINUE WITH GOOGLE ]
      </button>

      <p style={s.disclaimer}>
        Only registered participants can access this event.
      </p>

      <div style={s.statusBar}>
        <div>&gt;&gt; AUTHENTICATION_REQUIRED...</div>
        <div>&gt;&gt; INITIATING_SECURE_LOGIN...</div>
        <div>&gt;&gt; STANDBY.</div>
      </div>
    </>
  );
}

function ProfileView({
  profile,
  onSignOut,
}: {
  profile: ParticipantProfile;
  onSignOut: () => void;
}) {
  return (
    <>
      <p
        style={{
          ...s.siteLabel,
          marginBottom: "10px",
        }}
      >
        FRAGMENT // ASSIGNED
      </p>
      <h1
        style={{
          ...s.heading,
          fontSize: "clamp(30px,8vw,42px)",
          marginBottom: "28px",
        }}
      >
        IDENTITY{"\n"}CONFIRMED.
      </h1>

      <div style={s.infoBox}>
        <div style={s.infoLabel}>PARTICIPANT</div>
        <div style={s.infoValue}>{profile.name.toUpperCase()}</div>

        <div style={s.infoLabel}>ID</div>
        <div style={{ ...s.infoValue, marginBottom: "8px" }}>
          {profile.participant_code}
        </div>

        <div style={{ ...s.infoLabel, marginBottom: 0 }}>
          <span style={s.dot} />
          ACCOUNT LINKED
        </div>
      </div>

      <p style={s.subtext}>
        Your fragment is being prepared.
        <br />
        More will appear here soon.
      </p>

      <button id="btn-sign-out-profile" type="button" style={s.secondaryBtn} onClick={onSignOut}>
        [ SIGN OUT ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; FRAGMENT_LOADED...</div>
        <div>&gt;&gt; AWAITING_PARTNER...</div>
        <div>&gt;&gt; GOOD_LUCK.</div>
      </div>
    </>
  );
}

function NotRegisteredView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <h1 style={s.heading}>ACCESS{"\n"}DENIED.</h1>
      <p style={s.subtext}>
        Your Google account is not on the approved participant list for this
        event.
        <br />
        <br />
        If you registered with a different email address, sign out and try again
        with the correct Google account.
      </p>

      <button id="btn-sign-out-not-registered" type="button" style={s.secondaryBtn} onClick={onSignOut}>
        [ SIGN OUT AND TRY AGAIN ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; IDENTITY_NOT_FOUND...</div>
        <div>&gt;&gt; ACCESS_DENIED.</div>
      </div>
    </>
  );
}

function DeniedView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <h1 style={s.heading}>LINK{"\n"}ERROR.</h1>
      <p style={s.subtext}>
        There was a problem linking your account.
        <br />
        <br />
        If this keeps happening, contact an event organizer.
      </p>

      <button id="btn-sign-out-denied" type="button" style={s.secondaryBtn} onClick={onSignOut}>
        [ SIGN OUT ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; LINKING_DENIED...</div>
        <div>&gt;&gt; CONTACT_ORGANIZER.</div>
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

      <button id="btn-retry" type="button" style={s.primaryBtn} onClick={onRetry}>
        [ TRY AGAIN ]
      </button>

      <button id="btn-sign-out-error" type="button" style={s.secondaryBtn} onClick={onSignOut}>
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

/** Monochrome Google "G" icon — matches the button's dark text colour */
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