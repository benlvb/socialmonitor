"use client";

import { useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { name: string; args: Record<string, unknown>; result?: unknown }[];
}

/** Model output can echo attacker-controlled scraped content — always sanitize. */
function renderMarkdown(md: string): { __html: string } {
  return { __html: DOMPurify.sanitize(marked.parse(md) as string) };
}

export function AskChat({ monitorId }: { monitorId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [approval, setApproval] = useState<{
    calls: { name: string; args: unknown }[];
    pendingTurn: unknown[];
    sig: string;
  } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  async function send(history: ChatMessage[], approvedTurn?: unknown[], sig?: string) {
    setPending(true);
    setApproval(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          monitorId,
          approveTools: Boolean(approvedTurn),
          pendingTurn: approvedTurn,
          pendingTurnSig: sig,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = (await res.json().catch(() => ({ error: `request failed (${res.status})` }))) as {
        reply?: string;
        error?: string;
        toolCalls?: ChatMessage["toolCalls"];
        needsApproval?: { name: string; args: unknown }[];
        pendingTurn?: unknown[];
        pendingTurnSig?: string;
      };
      if (data.needsApproval && data.pendingTurn) {
        setApproval({
          calls: data.needsApproval,
          pendingTurn: data.pendingTurn,
          sig: data.pendingTurnSig ?? "",
        });
        return;
      }
      setMessages([
        ...history,
        {
          role: "assistant",
          content: data.reply || data.error || "(no answer)",
          toolCalls: data.toolCalls,
        },
      ]);
      setTimeout(() => scroller.current?.scrollTo({ top: 1e6 }), 50);
    } finally {
      setPending(false);
    }
  }

  const submit = () => {
    const q = input.trim();
    if (!q || pending) return;
    const history: ChatMessage[] = [...messages, { role: "user", content: q }];
    setMessages(history);
    setInput("");
    void send(history);
  };

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", height: "70vh" }}>
      <div ref={scroller} style={{ flex: 1, overflowY: "auto", paddingRight: 6 }}>
        {messages.length === 0 && (
          <p className="muted">
            Ask about what people are saying — e.g. &quot;what changed this week?&quot;, &quot;top
            complaints about the mobile app&quot;, &quot;show me the items behind the login theme&quot;.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 14 }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase" }}>
              {m.role === "user" ? "you" : "analyst"}
            </div>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div style={{ margin: "4px 0" }}>
                {m.toolCalls.map((t, j) => (
                  <details key={j} className="mono" style={{ fontSize: 11, margin: "2px 0" }}>
                    <summary>
                      🔧 {t.name}({JSON.stringify(t.args)})
                    </summary>
                    <pre style={{ maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>
                      {JSON.stringify(t.result, null, 2)}
                    </pre>
                  </details>
                ))}
              </div>
            )}
            {m.role === "assistant" ? (
              <div dangerouslySetInnerHTML={renderMarkdown(m.content)} />
            ) : (
              <div>{m.content}</div>
            )}
          </div>
        ))}
        {pending && <p className="muted">thinking…</p>}
        {approval && (
          <div className="card">
            <p>
              The analyst wants to run:{" "}
              {approval.calls.map((a, i) => (
                <code key={i} className="mono">
                  {a.name}({JSON.stringify(a.args)}){" "}
                </code>
              ))}
            </p>
            <div className="row">
              <button className="primary" onClick={() => void send(messages, approval.pendingTurn, approval.sig)}>
                Approve &amp; continue
              </button>
              <button onClick={() => setApproval(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      <form
        className="row"
        style={{ marginTop: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about this monitor's data…"
          disabled={pending}
        />
        <button className="primary" disabled={pending || !input.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}
