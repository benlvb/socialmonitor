"use client";

import { useActionState } from "react";
import { saveCredentials, testIntegration, type ConnectionState } from "./actions";

export function ConnectionCard({
  integration,
  title,
  description,
  fields,
  status,
  lastCheckedAt,
  envConfigured,
}: {
  integration: string;
  title: string;
  description: string;
  fields: { name: string; label: string; secret: boolean }[];
  status: string;
  lastCheckedAt: string | null;
  envConfigured: boolean;
}) {
  const [saveState, saveAction, savePending] = useActionState(saveCredentials, {} as ConnectionState);
  const [testState, testAction, testPending] = useActionState(testIntegration, {} as ConnectionState);

  const pill =
    status === "ok" ? (
      <span className="pill ok">● connected</span>
    ) : status === "failing" ? (
      <span className="pill err">● failing</span>
    ) : envConfigured ? (
      <span className="pill warn">● env-configured (untested)</span>
    ) : (
      <span className="pill idle">○ awaiting credentials</span>
    );

  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <div className="spacer" />
        {pill}
      </div>
      <p className="muted">{description}</p>
      <form action={saveAction}>
        <input type="hidden" name="integration" value={integration} />
        {fields.map((f) => (
          <div key={f.name}>
            <label htmlFor={`${integration}-${f.name}`}>{f.label}</label>
            <input
              id={`${integration}-${f.name}`}
              name={f.name}
              type={f.secret ? "password" : "text"}
              placeholder="(unchanged if left blank)"
              autoComplete="off"
            />
          </div>
        ))}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={savePending}>
            {savePending ? "Saving…" : "Save to Vault"}
          </button>
          <button formAction={testAction} disabled={testPending}>
            {testPending ? "Testing…" : "Test connection"}
          </button>
          {lastCheckedAt && (
            <span className="muted">last tested {new Date(lastCheckedAt).toLocaleString()}</span>
          )}
        </div>
        {(saveState.message || testState.message) && (
          <p className="success-text">{saveState.message ?? testState.message}</p>
        )}
        {(saveState.error || testState.error) && (
          <p className="error-text">{saveState.error ?? testState.error}</p>
        )}
      </form>
    </div>
  );
}
