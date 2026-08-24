"use client";

import { useActionState, useState } from "react";
import { correctClassification, type CorrectionState } from "./actions";

export function CorrectionForm({
  monitorId,
  source,
  externalId,
  signalTypes,
  current,
}: {
  monitorId: string;
  source: string;
  externalId: string;
  signalTypes: string[];
  current: {
    relevant: boolean;
    signal_type: string;
    sentiment: string;
    tags: string[];
    score: number | null;
    description: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(correctClassification, {} as CorrectionState);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Fix classification
      </button>
    );
  }

  return (
    <form action={action} className="card" style={{ marginTop: 8 }}>
      <input type="hidden" name="monitor_id" value={monitorId} />
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="external_id" value={externalId} />
      <div className="row">
        <div>
          <label>Relevant</label>
          <select name="relevant" defaultValue={String(current.relevant)}>
            <option value="true">relevant</option>
            <option value="false">noise</option>
          </select>
        </div>
        <div>
          <label>Signal type</label>
          <select name="signal_type" defaultValue={current.signal_type}>
            {signalTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label>Sentiment</label>
          <select name="sentiment" defaultValue={current.sentiment}>
            {["positive", "negative", "neutral", "mixed"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label>Score</label>
          <input name="score" type="number" min={1} max={10} defaultValue={current.score ?? ""} style={{ width: 70 }} />
        </div>
      </div>
      <label>Tags (comma-separated, max 3)</label>
      <input name="tags" defaultValue={current.tags.join(", ")} />
      <label>Description (theme key)</label>
      <input name="description" defaultValue={current.description} maxLength={200} />
      <label>Why? (becomes a few-shot example — say what the model got wrong)</label>
      <input name="note" placeholder="e.g. price talk, not product feedback" />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save correction"}</button>
        <button type="button" onClick={() => setOpen(false)}>Cancel</button>
        {state.message && <span className="success-text">{state.message}</span>}
        {state.error && <span className="error-text">{state.error}</span>}
      </div>
    </form>
  );
}
