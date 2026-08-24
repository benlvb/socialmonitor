"use client";

import { useActionState } from "react";
import { signIn, signUp, type AuthState } from "./actions";

const initial: AuthState = {};

export default function LoginPage() {
  const [signInState, signInAction, signInPending] = useActionState(signIn, initial);
  const [signUpState, signUpAction, signUpPending] = useActionState(signUp, initial);

  return (
    <main style={{ maxWidth: 380, margin: "10vh auto", padding: 16 }}>
      <div className="card">
        <h1>socialmonitor</h1>
        <p className="muted">Sign in with an allowlisted email.</p>
        <form>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoComplete="email" />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required autoComplete="current-password" />
          <div className="row" style={{ marginTop: 14 }}>
            <button className="primary" formAction={signInAction} disabled={signInPending}>
              {signInPending ? "Signing in…" : "Sign in"}
            </button>
            <button formAction={signUpAction} disabled={signUpPending}>
              {signUpPending ? "Creating…" : "Create account"}
            </button>
          </div>
          {(signInState.error || signUpState.error) && (
            <p className="error-text">{signInState.error ?? signUpState.error}</p>
          )}
          {signUpState.message && <p className="success-text">{signUpState.message}</p>}
        </form>
      </div>
    </main>
  );
}
