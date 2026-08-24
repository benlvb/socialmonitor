"use client";

import { useActionState } from "react";
import { updateMonitor, type MonitorFormState } from "../../actions";
import { TargetsEditor, type TargetRowInput } from "../../../../../components/targets-editor";

export function SettingsForm({
  monitorId,
  name,
  status,
  configJson,
  targets,
}: {
  monitorId: string;
  name: string;
  status: string;
  configJson: string;
  targets: TargetRowInput[];
}) {
  const bound = updateMonitor.bind(null, monitorId);
  const [state, action, pending] = useActionState(bound, {} as MonitorFormState);

  return (
    <form action={action}>
      <div className="card">
        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="name">Name</label>
            <input id="name" name="name" defaultValue={name} required />
          </div>
          <div>
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={status}>
              <option value="active">active</option>
              <option value="paused">paused</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Targets</h2>
        <p className="field-hint">What to watch per platform: accounts, keywords, subreddits, channels, guild ids.</p>
        <TargetsEditor initial={targets} />
      </div>

      <div className="card">
        <h2>Configuration (JSON)</h2>
        <p className="field-hint">
          Taxonomy, noise rules, seed examples, budgets, cadences, toggles — schema-validated on save.
          Copy this JSON out to export the monitor; paste to import.
        </p>
        <textarea name="config" className="code" rows={22} defaultValue={configJson} />
      </div>

      <div className="row">
        <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
        {state.message && <span className="success-text">{state.message}</span>}
        {state.error && <span className="error-text">{state.error}</span>}
      </div>
      {state.issues && (
        <ul className="error-text">
          {state.issues.map((i) => (
            <li key={i} className="mono">{i}</li>
          ))}
        </ul>
      )}
    </form>
  );
}
