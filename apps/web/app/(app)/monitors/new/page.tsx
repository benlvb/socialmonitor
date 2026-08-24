"use client";

import { useActionState } from "react";
import { createMonitor, type MonitorFormState } from "../actions";

export default function NewMonitorPage() {
  const [state, action, pending] = useActionState(createMonitor, {} as MonitorFormState);
  return (
    <div style={{ maxWidth: 480 }}>
      <h1>New monitor</h1>
      <div className="card">
        <form action={action}>
          <label htmlFor="name">Name</label>
          <input id="name" name="name" required placeholder="e.g. Acme brand watch" />
          <p className="field-hint">Targets, taxonomy, and budgets are configured on the next screen.</p>
          <button className="primary" disabled={pending} style={{ marginTop: 12 }}>
            {pending ? "Creating…" : "Create"}
          </button>
          {state.error && <p className="error-text">{state.error}</p>}
        </form>
      </div>
    </div>
  );
}
