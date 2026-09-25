import { useState, useEffect, useCallback, useRef } from "react";
import ParticipantPuzzle from "../../features/level1/ParticipantPuzzle";
import Level2Game from "../../features/level2/Level2Game";
import { supabase } from "../../lib/supabase";
import { isPairState, isVerifyResult, type PairState } from "./verificationState";
import "../../index.css"; // Ensure styles are loaded

// Event closing time: 24 September 2026 at 4:30 PM India Standard Time.
// Update this single value for a future event.
const EVENT_END_AT = new Date("2026-09-24T16:30:00+05:30");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LinkStatus =
  | "loading"
  | "unauthenticated"
  | "linked"
  | "not_registered"
  | "denied"
  | "error";

type PairStatus =
  | "error_pair"
  | "loading_pair"
  | "NOT_PAIRED"
  | "PAIRED"
  | "INCORRECT"
  | "LOCKED"
  | "SELF_VERIFIED"
  | "MUTUAL_VERIFIED";

// ---------------------------------------------------------------------------
// Design tokens (mapped to CSS variables)
// ---------------------------------------------------------------------------

const s = {
  page: {
    flex: "1",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    padding: "32px 24px",
    boxSizing: "border-box" as const,
  },
  card: {
    width: "100%",
    maxWidth: "420px",
    display: "flex",
    flexDirection: "column" as const,
    position: "relative" as const,
  },
  globalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottom: "1px solid var(--green-dim)",
    paddingBottom: "16px",
    marginBottom: "40px",
  },
  siteLabelTitle: {
    fontSize: "14px",
    fontFamily: "var(--font-pixel)",
    letterSpacing: "0.1em",
    color: "var(--green)",
    lineHeight: "1.2",
  },
  hamburger: {
    fontSize: "20px",
    color: "var(--green)",
    cursor: "pointer",
  },
  siteLabel: {
    fontSize: "11px",
    letterSpacing: "0.18em",
    color: "var(--green-dim)",
    marginBottom: "20px",
    lineHeight: "1.8",
  },
  heading: {
    fontFamily: "var(--font-pixel)",
    fontSize: "clamp(48px, 12vw, 64px)",
    fontWeight: "normal",
    color: "var(--green)",
    lineHeight: "0.9",
    letterSpacing: "0.02em",
    margin: "0 0 20px",
    textShadow: "0 0 10px var(--green-dim)",
  },
  subtext: {
    fontSize: "13px",
    color: "var(--green-dim)",
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
    background: "var(--green)",
    color: "var(--bg)",
    border: "none",
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
    fontWeight: "bold",
    letterSpacing: "0.14em",
    cursor: "pointer",
    marginBottom: "14px",
    boxShadow: "0 0 15px var(--green-faint)",
  },
  primaryBtnDisabled: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    width: "100%",
    padding: "16px 24px",
    background: "var(--green-faint)",
    color: "var(--green-dim)",
    border: "1px solid var(--green-faint)",
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
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
    color: "var(--green)",
    border: "1px solid var(--green)",
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
    fontWeight: "bold",
    letterSpacing: "0.14em",
    cursor: "pointer",
    opacity: 0.85,
  },
  disclaimer: {
    fontSize: "11px",
    color: "var(--green-dim)",
    letterSpacing: "0.06em",
    marginTop: "18px",
    lineHeight: "1.7",
  },
  statusBar: {
    marginTop: "48px",
    paddingTop: "16px",
    borderTop: "1px solid var(--green-faint)",
    fontSize: "10px",
    color: "var(--green-dim)",
    letterSpacing: "0.1em",
    lineHeight: "1.9",
    opacity: 0.7,
  },
  infoBox: {
    border: "1px solid var(--green-dim)",
    padding: "20px 20px 16px",
    marginBottom: "28px",
    background: "var(--green-faint)",
    position: "relative" as const,
  },
  infoBoxCorners: {
    position: "absolute" as const,
    top: "-1px",
    left: "-1px",
    right: "-1px",
    bottom: "-1px",
    border: "1px solid var(--green)",
    clipPath: "polygon(0 0, 10px 0, 0 10px, 0 0, 100% 0, 100% 10px, calc(100% - 10px) 0, 100% 0, 100% 100%, calc(100% - 10px) 100%, 100% calc(100% - 10px), 100% 100%, 0 100%, 0 calc(100% - 10px), 10px 100%, 0 100%)"
  },
  infoLabel: {
    fontSize: "10px",
    letterSpacing: "0.18em",
    color: "var(--green-dim)",
    marginBottom: "5px",
    display: "flex",
    justifyContent: "space-between",
  },
  infoValue: {
    fontSize: "18px",
    color: "var(--green)",
    fontWeight: "bold",
    letterSpacing: "0.04em",
    marginBottom: "18px",
  },
  dot: {
    display: "inline-block",
    width: "6px",
    height: "6px",
    background: "var(--green)",
    borderRadius: "50%",
    marginRight: "8px",
    verticalAlign: "middle",
    boxShadow: "0 0 6px var(--green)",
  },
  input: {
    width: "100%",
    padding: "16px 16px",
    background: "transparent",
    color: "var(--green)",
    border: "1px solid var(--green-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: "16px",
    letterSpacing: "0.12em",
    marginBottom: "16px",
    boxSizing: "border-box" as const,
    outline: "none",
    textTransform: "uppercase" as const,
  },
  warningBox: {
    border: "1px solid rgba(255,80,80,0.45)",
    padding: "14px 16px",
    marginBottom: "20px",
    background: "rgba(255,80,80,0.06)",
    fontSize: "13px",
    color: "rgba(255,120,120,0.9)",
    letterSpacing: "0.04em",
    lineHeight: "1.7",
  },
  successBox: {
    border: "1px solid var(--green-dim)",
    padding: "14px 16px",
    marginBottom: "20px",
    background: "var(--green-faint)",
    fontSize: "13px",
    color: "var(--green)",
    letterSpacing: "0.04em",
    lineHeight: "1.7",
  },
  gridGraphic: {
    width: "100%",
    height: "150px",
    border: "1px solid var(--green-dim)",
    marginBottom: "20px",
    display: "grid",
    gridTemplateColumns: "repeat(8, 1fr)",
    gridTemplateRows: "repeat(5, 1fr)",
    gap: "1px",
    background: "var(--green-faint)",
  },
  gridCellActive: {
    background: "var(--green)",
    opacity: 0.8,
  }
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ParticipantHome() {
  const [eventFinished, setEventFinished] = useState(() => new Date() >= EVENT_END_AT);
  const [linkStatus, setLinkStatus] = useState<LinkStatus>("loading");
  const verifyInFlight = useRef(false);
  const [puzzleRefresh, setPuzzleRefresh] = useState(0);
  const [level1Completed, setLevel1Completed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [pairStatus, setPairStatus] = useState<PairStatus>("loading_pair");
  const [pairState, setPairState] = useState<PairState | null>(null);
  const [partnerCodeInput, setPartnerCodeInput] = useState("");
  const [attemptsRemaining, setAttemptsRemaining] = useState<number>(2);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const updateEventStatus = () => setEventFinished(new Date() >= EVENT_END_AT);
    const timer = window.setInterval(updateEventStatus, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const loadPairState = useCallback(async () => {
    setErrorMessage(null);
    let ps: PairState;
    try {
      const { data, error } = await supabase.rpc("get_my_pair_state");
      if (error || !isPairState(data)) throw new Error("Invalid pair response");
      ps = data;
    } catch {
      setPairState(null);
      setPairStatus("error_pair");
      setErrorMessage("Could not load verification status. Please refresh status to try again.");
      return;
    }
    setPairState(ps);
    setPuzzleRefresh(value => value + 1);

    if (ps.status === "NOT_PAIRED") {
      setPairStatus("NOT_PAIRED");
      return;
    }

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

  const performLinking = useCallback(async () => {
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

    const result: unknown = data;

    if (result === "LINKED" || result === "ALREADY_LINKED") {
      setLinkStatus("linked");
      await loadPairState();
    } else if (result === "NOT_REGISTERED") {
      setLinkStatus("not_registered");
    } else if (result === "LINKING_DENIED") {
      setLinkStatus("denied");
    } else {
      setErrorMessage("An unexpected response was received. Please try again.");
      setLinkStatus("error");
    }
  }, [loadPairState]);

  useEffect(() => {
    async function initialize() {
      if (eventFinished) return;
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error || !session) {
          setLinkStatus("unauthenticated");
          return;
        }
        await performLinking();
      } catch {
        setErrorMessage("Could not connect. Please try again.");
        setLinkStatus("error");
      }
    }
    void initialize();
  }, [eventFinished, performLinking]);

  async function handleVerify() {
    const code = partnerCodeInput.trim().toUpperCase();
    if (!code || verifyInFlight.current ||
      (pairStatus !== "PAIRED" && pairStatus !== "INCORRECT") || attemptsRemaining <= 0) return;

    verifyInFlight.current = true;
    setIsVerifying(true);
    setErrorMessage(null);
    try {
      const { data, error } = await supabase.rpc("verify_my_partner", { partner_code: code });
      if (error || !isVerifyResult(data)) throw new Error("Invalid verification response");
      const result = data;
      const remaining = result.attempts_remaining ?? 0;
      setAttemptsRemaining(remaining);

      if (result.status === "VERIFIED") {
        setPuzzleRefresh(value => value + 1);
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
    } catch {
      setPairStatus("error_pair");
      setErrorMessage("Could not confirm verification. Refresh status before trying again.");
    } finally {
      verifyInFlight.current = false;
      setIsVerifying(false);
    }
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    await loadPairState();
    setIsRefreshing(false);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setErrorMessage(null);
    setPairState(null);
    setLevel1Completed(false);
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

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.globalHeader}>
          <div style={s.siteLabelTitle}>
            MEC.CONF<br />PRE-EVENT
          </div>
          <div style={s.hamburger}>≡</div>
        </div>

        {eventFinished ? <EventFinishedView /> : <>
          {linkStatus === "loading" && <LoadingView />}

          {linkStatus === "unauthenticated" && (
            <LoginView onSignIn={handleGoogleSignIn} />
          )}

          {linkStatus === "linked" && (
            <>
              <ParticipantPuzzle refreshToken={puzzleRefresh} onCompletedChange={setLevel1Completed} />
              {!level1Completed && <>
                {pairStatus === "loading_pair" && <LoadingView />}

                {pairStatus === "NOT_PAIRED" && (
                  <NotPairedView onSignOut={handleSignOut} />
                )}

                {pairStatus === "error_pair" && (
                  <ErrorView message={errorMessage} onRetry={handleRefresh} onSignOut={handleSignOut} />
                )}

                {(pairStatus === "PAIRED" || pairStatus === "INCORRECT") && pairState && (
                  <>
                    <div style={s.infoBox}>
                      <div style={s.infoLabel}>Participant</div>
                      <div style={{ ...s.infoValue, overflowWrap: "anywhere" }}>{pairState.name}</div>
                      <div style={s.infoLabel}>Participant code</div>
                      <div style={{ ...s.infoValue, overflowWrap: "anywhere" }}>{pairState.participant_code}</div>
                      <div>FRAGMENT {pairState.fragment_slot}</div>
                    </div>
                    <VerificationView
                      attemptsRemaining={attemptsRemaining}
                      isIncorrect={pairStatus === "INCORRECT"}
                      partnerCodeInput={partnerCodeInput}
                      onPartnerCodeChange={setPartnerCodeInput}
                      onVerify={handleVerify}
                      isVerifying={isVerifying}
                    />
                  </>
                )}

                {pairStatus === "LOCKED" && (
                  <LockedView onSignOut={handleSignOut} />
                )}

                {pairStatus === "SELF_VERIFIED" && (
                  <SelfVerifiedView
                    onRefresh={handleRefresh}
                    isRefreshing={isRefreshing}
                  />
                )}

                {pairStatus === "MUTUAL_VERIFIED" && (
                  <MutualVerifiedView />
                )}
              </>}
              {level1Completed && (
                <Level2Game onCompletedChange={() => { }} />
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
        </>}
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

function EventFinishedView() {
  return (
    <>
      <h1 style={s.heading}>EVENT<br />ENDED.</h1>
      <p style={s.subtext}>
        Thank you for participating.<br />
        This participant portal is now closed.
      </p>
      <div style={s.successBox}>
        <div><span style={s.dot} />EVENT COMPLETE</div>
        <div style={{ marginTop: "8px" }}>The event finished at 4:30 PM.</div>
      </div>
      <div style={s.statusBar}>
        <div>&gt;&gt; EVENT_STATUS: COMPLETE...</div>
        <div>&gt;&gt; PARTICIPANT_ACCESS: CLOSED.</div>
      </div>
    </>
  );
}

function LoginView({ onSignIn }: { onSignIn: () => void }) {
  return (
    <>
      <h1 style={s.heading}>YOUR HALF<br />AWAITS.</h1>
      <p style={{ ...s.subtext, marginBottom: "28px" }}>
        One puzzle. Two fragments.<br />
        Find your partner. Solve together.
      </p>

      <img
        src="/split-faces.png"
        alt="Split face fragments awaiting connection"
        style={{
          width: "100%",
          height: "auto",
          display: "block",
          margin: "12px 0 28px",
          mixBlendMode: "screen",
        }}
      />

      <button id="btn-google-signin" type="button" style={s.primaryBtn} onClick={onSignIn}>
        <GoogleIcon /> [ CONTINUE WITH GOOGLE ]
      </button>

      <p style={s.disclaimer}>
        Only registered participants can access this event.
      </p>

      <div style={s.statusBar}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            &gt;&gt; AUTHENTICATION_REQUIRED...<br />
            &gt;&gt; INITIATING_SECURE_LOGIN...<br />
            &gt;&gt; STANDBY...
          </div>
          <div style={{ textAlign: 'right' }}>
            MEC.CONF<br />2026
          </div>
        </div>
      </div>
    </>
  );
}

function NotPairedView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <h1 style={s.heading}>PENDING.</h1>
      <p style={s.subtext}>
        Pair assignment pending.<br />
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
  attemptsRemaining,
  isIncorrect,
  partnerCodeInput,
  onPartnerCodeChange,
  onVerify,
  isVerifying,
}: {
  attemptsRemaining: number;
  isIncorrect: boolean;
  partnerCodeInput: string;
  onPartnerCodeChange: (v: string) => void;
  onVerify: () => void;
  isVerifying: boolean;
}) {
  const canSubmit = partnerCodeInput.trim().length > 0 && !isVerifying && attemptsRemaining > 0;

  return (
    <>
      <h1 style={{ ...s.heading, fontSize: "42px" }}>
        VERIFY<br />YOUR PARTNER.
      </h1>

      <p style={{ ...s.subtext, marginBottom: "28px" }}>
        Enter your partner's<br />
        Participant ID to confirm<br />
        your connection.
      </p>

      {isIncorrect && (
        <div style={s.warningBox} role="alert">
          Incorrect partner code. Please try again.
        </div>
      )}

      <div style={{ ...s.infoLabel, marginBottom: "8px" }}>
        Partner ID
      </div>

      <input
        id="input-partner-code"
        type="text"
        placeholder="MEC-XXX"
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

      <div style={{ ...s.infoLabel, marginBottom: "20px" }}>
        Attempts remaining: {attemptsRemaining}
      </div>

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

      <div style={s.statusBar}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            &gt;&gt; SEEKING_CONNECTION...<br />
            &gt;&gt; INPUT_PARTNER_ID...<br />
            &gt;&gt; ESTABLISH_LINK...
          </div>
          <div style={{ textAlign: 'right' }}>
            MEC.CONF<br />2026
          </div>
        </div>
      </div>
    </>
  );
}

function LockedView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <h1 style={{ ...s.heading, fontSize: "42px" }}>
        VERIFICATION<br />LOCKED.
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
}: {
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  return (
    <>
      <h1 style={{ ...s.heading, fontSize: "42px" }}>
        PARTNER<br />VERIFIED.
      </h1>
      <div style={s.successBox}>
        <div><span style={s.dot} />Partner verified.</div>
        <div style={{ marginTop: "8px" }}>Waiting for your partner to verify you.</div>
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
      <div style={s.statusBar}>
        <div>&gt;&gt; SELF_VERIFIED: TRUE...</div>
        <div>&gt;&gt; PARTNER_VERIFIED: PENDING...</div>
        <div>&gt;&gt; AWAITING_MUTUAL_CONFIRMATION.</div>
      </div>
    </>
  );
}

function MutualVerifiedView() {
  return (
    <>
      <h1 style={{ ...s.heading, fontSize: "clamp(28px, 8vw, 38px)" }}>
        CONNECTION ESTABLISHED
      </h1>
      <p style={s.subtext}>Both participants verified.</p>
    </>
  );
}

function NotRegisteredView({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <h1 style={s.heading}>ACCESS<br />DENIED.</h1>
      <p style={s.subtext}>
        Your Google account is not on the approved participant list for this event.
        <br /><br />
        If you registered with a different email address, sign out and try again with the correct Google account.
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
      <h1 style={s.heading}>LINK<br />ERROR.</h1>
      <p style={s.subtext}>
        There was a problem linking your account.
        <br /><br />
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
      <h1 style={s.heading}>TRANSMISSION<br />FAILED.</h1>
      <p style={s.subtext}>{message ?? "An unexpected error occurred. Please try again."}</p>
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

function GoogleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="var(--bg)" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}
