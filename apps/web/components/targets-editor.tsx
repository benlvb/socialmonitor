"use client";

import { useState } from "react";
import { SOURCES, SOURCE_LABELS, TARGET_KINDS, type Source } from "@socialmonitor/shared";

export interface TargetRowInput {
  source: Source;
  kind: string;
  value: string;
  enabled: boolean;
}

/** Client-side table editor; serializes to a hidden JSON input on submit. */
export function TargetsEditor({ initial }: { initial: TargetRowInput[] }) {
  const [rows, setRows] = useState<TargetRowInput[]>(initial);

  const update = (i: number, patch: Partial<TargetRowInput>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div>
      <input type="hidden" name="targets" value={JSON.stringify(rows)} />
      <table className="data">
        <thead>
          <tr><th>Source</th><th>Kind</th><th>Value</th><th>On</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <select
                  value={r.source}
                  onChange={(e) => {
                    const source = e.target.value as Source;
                    update(i, { source, kind: TARGET_KINDS[source][0]! });
                  }}
                >
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
                  ))}
                </select>
              </td>
              <td>
                <select value={r.kind} onChange={(e) => update(i, { kind: e.target.value })}>
                  {TARGET_KINDS[r.source].map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  value={r.value}
                  placeholder={
                    r.kind === "keyword"
                      ? "search phrase"
                      : r.kind === "app" || r.kind === "app_public"
                        ? "package name / App Store id, or the store URL"
                        : `${r.kind} name / id`
                  }
                  onChange={(e) => update(i, { value: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  style={{ width: "auto" }}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                />
              </td>
              <td>
                <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        style={{ marginTop: 8 }}
        onClick={() =>
          setRows((rs) => [...rs, { source: "x", kind: "keyword", value: "", enabled: true }])
        }
      >
        + Add target
      </button>
    </div>
  );
}
