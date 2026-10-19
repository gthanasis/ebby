import { useState } from "react";
import { Logo } from "./Logo";
import { Icon } from "./ui";

/** Where the server sends you back after Google: #/login/error=not_allowed&email=… or #/login/signed_out=1. */
function loginParams() {
  return new URLSearchParams(location.hash.replace(/^#\/?login\/?/, ""));
}

export function Login() {
  const params = loginParams();
  const error = params.get("error");
  const email = params.get("email");
  const [going, setGoing] = useState(false);

  return (
    <main className="login">
      <div className="login-sky" aria-hidden="true"><i /><i /><i /></div>
      <div className="login-grid" aria-hidden="true" />

      <div className="login-body">
        <div className="login-mark" aria-hidden="true"><Logo live /></div>

        <h1>ebby</h1>
        <p className="login-lede">Every bank you use, in one place. Sign in to see where the money went this month.</p>

        {error === "not_allowed" && (
          <div className="notice warn" role="alert">
            <Icon icon="mdi:alert-circle-outline" />
            <div><b>{email ? `${email} isn't on the list` : "This email isn't on the list"}</b>
              <p className="muted">ebby is invite only. Ask whoever runs it to add you, then sign in again.</p></div>
          </div>
        )}
        {error && error !== "not_allowed" && (
          <div className="notice bad" role="alert">
            <Icon icon="mdi:alert-circle-outline" />
            <div><b>Couldn't sign you in</b><p className="muted">Google didn't finish the sign-in. Try again.</p></div>
          </div>
        )}
        {params.has("signed_out") && !error && (
          <div className="notice"><Icon icon="mdi:check-circle-outline" /><div><b>You're signed out</b></div></div>
        )}

        <a className={`btn block login-google ${going ? "going" : ""}`} href="/auth/google" aria-busy={going}
          onClick={() => setGoing(true)}>
          <Icon icon={going ? "mdi:sync" : "mdi:google"} className={going ? "spin" : ""} />
          {going ? "Opening Google…" : "Continue with Google"}
        </a>

        <p className="login-fine"><Icon icon="mdi:shield-check-outline" />Invite only. Your bank keys are stored encrypted.</p>
      </div>
    </main>
  );
}
