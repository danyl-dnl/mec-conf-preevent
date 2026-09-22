import { supabase } from "../../lib/supabase";

export default function ParticipantHome() {
  const handleGoogleSignIn = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (error) {
      console.error("Google sign-in failed:", error.message);
      alert("Could not start Google sign-in. Please try again.");
    }
  };

  return (
    <main style={{ padding: "40px" }}>
      <h1>MEC CONF Pre-Event</h1>

      <p>Sign in to begin your puzzle challenge.</p>

      <button type="button" onClick={handleGoogleSignIn}>
        Continue with Google
      </button>
    </main>
  );
}