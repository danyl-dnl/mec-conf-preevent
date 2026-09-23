import { useState, useEffect, useCallback } from "react";
import { supabase } from "../../lib/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParticipantProfile {
  id: string;
  participant_code: string;
  name: string;
  registered_email: string;
}

/** States for the account-linking phase */
type LinkStatus =
  | "loading"
  | "unauthenticated"
  | "linked"
  | "not_registered"
  | "denied"
  | "error";

/** States for the pair-verification phase (active when linkStatus === "linked") */
type PairStatus =
  | "loading_pair"      // fetching pair state
  | "NOT_PAIRED"        // no pair assigned yet
  | "PAIRED"            // paired, not yet verified
  | "INCORRECT"         // last attempt was wrong
  | "LOCKED"            // too many wrong attempts
  | "SELF_VERIFIED"     // self verified, waiting for partner
  | "MUTUAL_VERIFIED";  // both verified

/** Raw shape returned by get_my_pair_state() */
interface PairState {
  status: "NOT_PAIRED" | "PAIRED";
  participant_code: string;
  name: string;
  fragment_slot?: "A" | "B";
  wrong_attempts?: number;
  attempts_remaining?: number;
  is_locked?: boolean;
  self_verified?: boolean;
  partner_verified?: boolean;
  mutual_verified?: boolean;
}

/** Raw shape returned by verify_my_partner() */
interface VerifyResult {
  status: "VERIFIED" | "INCORRECT" | "LOCKED";
  self_verified?: boolean;
  partner_verified?: boolean;
  mutual_verified?: boolean;
  attempts_remaining?: number;
}

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
  primaryBtnDisabled: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    width: "100%",
    padding: "16px 24px",
    background: GREEN_FAINT,
    color: GREEN_DIM,
    border: `1px solid ${GREEN_FAINT}`,
    fontFamily: "'Courier New', Courier, monospace",
    fontSize: "13px",
    fontWeight: "bold",
    letterSpacing: "0.14em",
    cursor: "not-allowed",
    marginBottom: "14px",
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
  input: {
    width: "100%",
    padding: "14px 16px",
    background: "transparent",
    color: GREEN,
    border: `1px solid ${GREEN_DIM}`,
    fontFamily: "'Courier New', Courier, monospace",
    fontSize: "16px",
    letterSpacing: "0.12em",
    marginBottom: "16px",
    boxSizing: "border-box" as const,
    outline: "none",
    textTransform: "uppercase" as const,
  },
  warningBox: {
    border: `1px solid rgba(255,80,80,0.45)`,
    padding: "14px 16px",
    marginBottom: "20px",
    background: "rgba(255,80,80,0.06)",
    fontSize: "13px",
    color: "rgba(255,120,120,0.9)",
    letterSpacing: "0.04em",
    lineHeight: "1.7",
  },
  successBox: {
    border: `1px solid ${GREEN_FAINT}`,
    padding: "14px 16px",
    marginBottom: "20px",
    background: "rgba(57,255,20,0.05)",
    fontSize: "13px",
    color: GREEN_DIM,
    letterSpacing: "0.04em",
    lineHeight: "1.7",
  },
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ParticipantHome() {
  const [linkStatus, setLinkStatus] = useState<LinkStatus>("loading");
  const [profile, setProfile] = useState<ParticipantProfile | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Pair/verification state
  const [pairStatus, setPairStatus] = useState<PairStatus>("loading_pair");
  const [pairState, setPairState] = useState<PairState | null>(null);
  const [partnerCodeInput, setPartnerCodeInput] = useState("");
  const [attemptsRemaining, setAttemptsRemaining] = useState<number>(2);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Match body background to terminal theme
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = BG;
    return () => {
      document.body.style.background = prev;
    };
  }, []);

  // loadPairState declared before the useEffect that depends on it
  const loadPairState = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_my_pair_state");

    if (error) {
      console.error("get_my_pair_state:", error.message);
      return;
    }

    // Runtime validation: must be an object with a status string
    if (
      !data ||
      typeof data !== "object" ||
      typeof (data as Record<string, unknown>)["status"] !== "string"
    ) {
      console.error("Unexpected pair state shape:", data);
      return;
    }

    const ps = data as unknown as PairState;
    setPairState(ps);

    if (ps.status === "NOT_PAIRED") {
      setPairStatus("NOT_PAIRED");
      return;
    }

    // PAIRED branch — derive UI state from flags
    const remaining = ps.attempts_remaining ?? 2;
    setAttemptsRemaining(remaining);

    if (ps.is_locked) {
      setPairStatus("LOCKED");
    } else if (ps.mutual_verified) {
      setPairStatus("MUTUAL_VERIFIED");
    } else if (ps.self_verified) {
      setPairStatus("SELF_VERIFIED");
    } else {
      setPairStatus("PAIRED");
    }
  }, []);

  // On mount: check session and link
  useEffect(() => {
    checkSessionAndLink();
  }, []);

  // Once linked, load pair state
  useEffect(() => {
    if (linkStatus === "linked") {
      loadPairState();
    }
  }, [linkStatus, loadPairState]);

  async function checkSessionAndLink() {
    setLinkStatus("loading");
    const { data: { session }, error: sessionError } =
      await supabase.auth.getSession();

    if (sessionError || !session) {
      setLinkStatus("unauthenticated");
      return;
    }

    await performLinking();
  }

  async function performLinking() {
    setLinkStatus("loading");
    setErrorMessage(null);

    const { data, error: rpcError } = await supabase.rpc(
      "link_current_participant",
    );

    if (rpcError) {
      console.error("link_current_participant:", rpcError.message);
      setErrorMessage(
        "Could not reach the server. Check your connection and try again.",
      );
      setLinkStatus("error");
      return;
    }

    const result = data as string | null;

    if (result === "LINKED" || result === "ALREADY_LINKED") {
      const { data: row, error: fetchError } = await supabase
        .from("participants")
        .select("id, participant_code, name, registered_email")
        .single();

      if (fetchError || !row) {
        console.error("Profile fetch failed:", fetchError?.message);
        setErrorMessage(
          "Your account was linked but your profile could not be loaded. Try refreshing the page.",
        );
        setLinkStatus("error");
        return;
      }

      setProfile(row as ParticipantProfile);
      setLinkStatus("linked");
    } else if (result === "NOT_REGISTERED") {
      setLinkStatus("not_registered");
    } else if (result === "LINKING_DENIED") {
      setLinkStatus("denied");
    } else {
      setErrorMessage("An unexpected response was received. Please try again.");
      setLinkStatus("error");
    }
  }



  async function handleVerify() {
    const code = partnerCodeInput.trim().toUpperCase();
    if (!code || isVerifying) return;

    setIsVerifying(true);

    // Only send partner_code — never any identity info
    const { data, error } = await supabase.rpc("verify_my_partner", {
      partner_code: code,
    });

    setIsVerifying(false);

    if (error) {
      console.error("verify_my_partner:", error.message);
      // Surface generic error without leaking server details
      return;
    }

    // Runtime validation
    if (
      !data ||
      typeof data !== "object" ||
      typeof (data as Record<string, unknown>)["status"] !== "string"
    ) {
      console.error("Unexpected verify response shape:", data);
      return;
    }

    const result = data as unknown as VerifyResult;
    const remaining = result.attempts_remaining ?? 0;
    setAttemptsRemaining(remaining);

    if (result.status === "VERIFIED") {
      if (result.mutual_verified) {
        setPairStatus("MUTUAL_VERIFIED");
      } else {
        setPairStatus("SELF_VERIFIED");
      }
      setPartnerCodeInput("");
    } else if (result.status === "INCORRECT") {
      setPairStatus("INCORRECT");
      setPartnerCodeInput("");
    } else if (result.status === "LOCKED") {
      setPairStatus("LOCKED");
      setPartnerCodeInput("");
    }
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    await loadPairState();
    setIsRefreshing(false);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setProfile(null);
    setErrorMessage(null);
    setPairState(null);
    setPairStatus("loading_pair");
    setPartnerCodeInput("");
    setLinkStatus("unauthenticated");
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

        {linkStatus === "loading" && <LoadingView />}

        {linkStatus === "unauthenticated" && (
          <LoginView onSignIn={handleGoogleSignIn} />
        )}

        {linkStatus === "linked" && profile && (
          <>
            {pairStatus === "loading_pair" && <LoadingView />}

            {pairStatus === "NOT_PAIRED" && (
              <NotPairedView onSignOut={handleSignOut} />
            )}

            {(pairStatus === "PAIRED" || pairStatus === "INCORRECT") &&
              pairState && (
                <VerificationView
                  pairState={pairState}
                  attemptsRemaining={attemptsRemaining}
                  isIncorrect={pairStatus === "INCORRECT"}
                  partnerCodeInput={partnerCodeInput}
                  onPartnerCodeChange={setPartnerCodeInput}
                  onVerify={handleVerify}
                  isVerifying={isVerifying}
                  onSignOut={handleSignOut}
                />
              )}

            {pairStatus === "LOCKED" && (
              <LockedView onSignOut={handleSignOut} />
            )}

            {pairStatus === "SELF_VERIFIED" && (
              <SelfVerifiedView
                onRefresh={handleRefresh}
                isRefreshing={isRefreshing}
                onSignOut={handleSignOut}
              />
            )}

            {pairStatus === "MUTUAL_VERIFIED" && (
              <MutualVerifiedView onSignOut={handleSignOut} />
            )}
          </>
        )}

        {linkStatus === "not_registered" && (
          <NotRegisteredView onSignOut={handleSignOut} />
        )}

        {linkStatus === "denied" && <DeniedView onSignOut={handleSignOut} />}

        {linkStatus === "error" && (
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
// Sub-views
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

function NotPairedView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <p style={{ ...s.siteLabel, marginBottom: "10px" }}>
        PAIR ASSIGNMENT
      </p>
      <h1 style={{ ...s.heading, fontSize: "clamp(30px,8vw,42px)", marginBottom: "28px" }}>
        PENDING.
      </h1>

      <p style={s.subtext}>
        Pair assignment pending.
        <br />
        Check back once the event organisers have assigned pairs.
      </p>

      <button id="btn-sign-out-not-paired" type="button" style={s.secondaryBtn} onClick={onSignOut}>
        [ SIGN OUT ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; AWAITING_PAIR_ASSIGNMENT...</div>
        <div>&gt;&gt; STANDBY.</div>
      </div>
    </>
  );
}

function VerificationView({
  pairState,
  attemptsRemaining,
  isIncorrect,
  partnerCodeInput,
  onPartnerCodeChange,
  onVerify,
  isVerifying,
  onSignOut,
}: {
  pairState: PairState;
  attemptsRemaining: number;
  isIncorrect: boolean;
  partnerCodeInput: string;
  onPartnerCodeChange: (v: string) => void;
  onVerify: () => void;
  isVerifying: boolean;
  onSignOut: () => void;
}) {
  const canSubmit = partnerCodeInput.trim().length > 0 && !isVerifying && attemptsRemaining > 0;

  return (
    <>
      <p style={{ ...s.siteLabel, marginBottom: "10px" }}>
        FRAGMENT // {pairState.fragment_slot ?? "?"}
      </p>
      <h1 style={{ ...s.heading, fontSize: "clamp(30px,8vw,42px)", marginBottom: "28px" }}>
        VERIFY{"\n"}PARTNER.
      </h1>

      <div style={s.infoBox}>
        <div style={s.infoLabel}>PARTICIPANT</div>
        <div style={s.infoValue}>{pairState.name.toUpperCase()}</div>

        <div style={s.infoLabel}>YOUR CODE</div>
        <div style={{ ...s.infoValue, marginBottom: "8px" }}>
          {pairState.participant_code}
        </div>

        <div style={{ ...s.infoLabel, marginBottom: 0 }}>
          FRAGMENT {pairState.fragment_slot ?? "?"}
        </div>
      </div>

      {isIncorrect && (
        <div style={s.warningBox}>
          Incorrect partner code.
          {attemptsRemaining === 1
            ? " 1 attempt remaining."
            : ` ${attemptsRemaining} attempts remaining.`}
        </div>
      )}

      {!isIncorrect && (
        <div style={{ ...s.infoLabel, marginBottom: "8px" }}>
          ATTEMPTS REMAINING: {attemptsRemaining}
        </div>
      )}

      <input
        id="input-partner-code"
        type="text"
        placeholder="PARTNER CODE"
        value={partnerCodeInput}
        onChange={(e) => onPartnerCodeChange(e.target.value)}
        style={s.input}
        maxLength={32}
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSubmit) onVerify();
        }}
        disabled={isVerifying}
        aria-label="Partner code"
      />

      <button
        id="btn-verify-partner"
        type="button"
        style={canSubmit ? s.primaryBtn : s.primaryBtnDisabled}
        onClick={onVerify}
        disabled={!canSubmit}
        aria-disabled={!canSubmit}
      >
        {isVerifying ? "[ VERIFYING... ]" : "[ VERIFY PARTNER ]"}
      </button>

      <button id="btn-sign-out-verify" type="button" style={s.secondaryBtn} onClick={onSignOut}>
        [ SIGN OUT ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; PAIRED_STATUS: ACTIVE...</div>
        <div>&gt;&gt; AWAITING_VERIFICATION...</div>
        <div>&gt;&gt; ENTER_PARTNER_CODE.</div>
      </div>
    </>
  );
}

function LockedView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <h1 style={{ ...s.heading, fontSize: "clamp(30px,8vw,42px)", marginBottom: "28px" }}>
        VERIFICATION{"\n"}LOCKED.
      </h1>

      <p style={s.subtext}>
        Verification locked. Contact an organizer.
      </p>

      <button id="btn-sign-out-locked" type="button" style={s.secondaryBtn} onClick={onSignOut}>
        [ SIGN OUT ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; VERIFICATION_LOCKED...</div>
        <div>&gt;&gt; CONTACT_ORGANIZER.</div>
      </div>
    </>
  );
}

function SelfVerifiedView({
  onRefresh,
  isRefreshing,
  onSignOut,
}: {
  onRefresh: () => void;
  isRefreshing: boolean;
  onSignOut: () => void;
}) {
  return (
    <>
      <p style={{ ...s.siteLabel, marginBottom: "10px" }}>
        VERIFICATION // IN PROGRESS
      </p>
      <h1 style={{ ...s.heading, fontSize: "clamp(30px,8vw,42px)", marginBottom: "28px" }}>
        PARTNER{"\n"}VERIFIED.
      </h1>

      <div style={s.successBox}>
        <div>
          <span style={s.dot} />
          Partner verified.
        </div>
        <div style={{ marginTop: "8px" }}>
          Waiting for your partner to verify you.
        </div>
      </div>

      <button
        id="btn-refresh-status"
        type="button"
        style={isRefreshing ? s.primaryBtnDisabled : s.primaryBtn}
        onClick={onRefresh}
        disabled={isRefreshing}
        aria-disabled={isRefreshing}
      >
        {isRefreshing ? "[ REFRESHING... ]" : "[ REFRESH STATUS ]"}
      </button>

      <button id="btn-sign-out-self-verified" type="button" style={s.secondaryBtn} onClick={onSignOut}>
        [ SIGN OUT ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; SELF_VERIFIED: TRUE...</div>
        <div>&gt;&gt; PARTNER_VERIFIED: PENDING...</div>
        <div>&gt;&gt; AWAITING_MUTUAL_CONFIRMATION.</div>
      </div>
    </>
  );
}

function MutualVerifiedView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <p style={{ ...s.siteLabel, marginBottom: "10px" }}>
        VERIFICATION // COMPLETE
      </p>
      <h1 style={{ ...s.heading, fontSize: "clamp(28px,7vw,38px)", marginBottom: "28px" }}>
        CONNECTION{"\n"}ESTABLISHED.
      </h1>

      <div style={s.successBox}>
        <div>
          <span style={s.dot} />
          Both participants verified.
        </div>
      </div>

      <p style={s.subtext}>
        Both participants verified.
        <br />
        Stand by for further instructions.
      </p>

      <button id="btn-sign-out-mutual" type="button" style={s.secondaryBtn} onClick={onSignOut}>
        [ SIGN OUT ]
      </button>

      <div style={s.statusBar}>
        <div>&gt;&gt; MUTUAL_VERIFIED: TRUE...</div>
        <div>&gt;&gt; CONNECTION_ESTABLISHED.</div>
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