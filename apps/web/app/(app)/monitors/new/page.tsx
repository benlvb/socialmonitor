"use client";

import { useActionState, useState } from "react";
import { createMonitor, type MonitorFormState } from "../actions";
import { MONITOR_TEMPLATES } from "../../../../lib/monitor-templates";

export default function NewMonitorPage() {
  const [state, action, pending] = useActionState(createMonitor, {} as MonitorFormState);
  const [template, setTemplate] = useState("brand");

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>New monitor</h1>
      <form action={action}>
        <div className="card">
          <label htmlFor="name">Name</label>
          <input id="name" name="name" required placeholder="e.g. Acme brand watch" />
        </div>

        <div className="card">
          <h2>Start from a template</h2>
          <p className="field-hint">
            Templates pre-fill the taxonomy, noise rules, and seed examples — edit the
            [BRACKETED] placeholders on the next screen.
          </p>
          <input type="hidden" name="template" value={template} />
          <div className="grid cols-2" style={{ marginTop: 8 }}>
            {MONITOR_TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTemplate(t.key)}
                className="card"
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  marginBottom: 0,
                  borderColor: template === t.key ? "var(--accent)" : "var(--border)",
                  borderWidth: template === t.key ? 2 : 1,
                }}
              >
                <b>{t.title}</b>
                <p className="muted" style={{ margin: "4px 0 0" }}>{t.description}</p>
              </button>
            ))}
          </div>
        </div>

        <button className="primary" disabled={pending}>
          {pending ? "Creating…" : "Create monitor"}
        </button>
        {state.error && <p className="error-text">{state.error}</p>}
      </form>
    </div>
  );
}
