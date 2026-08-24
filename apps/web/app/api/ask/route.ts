import { createHmac, timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createDb } from "@socialmonitor/db";
import { parseMonitorConfig } from "@socialmonitor/shared";
import { getMonthCostUsd, recordUsage } from "@socialmonitor/pipeline/repos";
import { resolveCredentials } from "@socialmonitor/pipeline/adapters";
import { DEFAULT_NARRATE_MODEL, estimateCostUsd } from "@socialmonitor/pipeline/llm";
import { createClient } from "../../../lib/supabase/server";
import { isAllowedEmail } from "../../../lib/allowlist";
import { ASK_TOOLS, buildDigest, runAskTool } from "../../../lib/ask-tools";

export const maxDuration = 120;

const MAX_TOOL_ROUNDS = 5;
const HISTORY_CAP = 20;
const DIGEST_TTL_MS = 5 * 60 * 1000;
const DIGEST_CACHE_MAX = 100;
const GLOBAL_CAP_USD = Number(process.env.GLOBAL_MONTHLY_LLM_CAP_USD ?? 50);

const digestCache = new Map<string, { expiresAt: number; digest: unknown }>();

const BodySchema = z.object({
  monitorId: z.string().uuid(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(80),
  approveTools: z.boolean().optional(),
  /** The paused assistant turn (content blocks) being approved — round-trips verbatim. */
  pendingTurn: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  /** HMAC over the pending turn — proves this server produced it (audit #13). */
  pendingTurnSig: z.string().max(128).optional(),
});

const SIGN_SECRET =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.ANTHROPIC_API_KEY ?? "socialmonitor-dev";
if (SIGN_SECRET === "socialmonitor-dev") {
  console.warn(
    "[ask] approval-gate signing key falling back to a constant — set SUPABASE_SERVICE_ROLE_KEY",
  );
}

function signTurn(monitorId: string, turn: unknown): string {
  return createHmac("sha256", SIGN_SECRET)
    .update(monitorId + JSON.stringify(turn))
    .digest("hex");
}

function verifyTurnSig(monitorId: string, turn: unknown, sig: string | undefined): boolean {
  if (!sig) return false;
  const expected = signTurn(monitorId, turn);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig.length === expected.length ? sig : "", "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

/**
 * /ask (D17): digest-first, four read-only tools, auto-executed. When the
 * per-monitor approval gate is on, the pending assistant turn is returned to
 * the client and, on approval, resumed verbatim — exactly the approved tool
 * calls run; later rounds gate again. All spend is recorded to llm_usage and
 * the global monthly cap applies.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!isAllowedEmail(user.email ?? "")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "malformed request" }, { status: 400 });
  }
  const body = parsed.data;

  const { data: monitor } = await supabase
    .from("monitors")
    .select("id, name, config")
    .eq("id", body.monitorId)
    .single();
  if (!monitor) return NextResponse.json({ error: "monitor not found" }, { status: 404 });

  const sql = createDb();
  if (!sql) return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 500 });

  try {
    // Vault-aware (audit #7): the Connections page key works without env vars.
    const anthropicCreds = await resolveCredentials(sql, user.id, "anthropic");
    const apiKey = anthropicCreds?.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        reply:
          "The Anthropic API key isn't configured yet — plug it in on the Connections page to activate /ask.",
        toolCalls: [],
      });
    }

    const monthCost = await getMonthCostUsd(sql);
    if (monthCost >= GLOBAL_CAP_USD) {
      return NextResponse.json({
        reply: `The monthly LLM cap ($${GLOBAL_CAP_USD}) has been reached ($${monthCost.toFixed(2)} spent) — /ask is paused until next month or a raised cap.`,
        toolCalls: [],
      });
    }

    const config = parseMonitorConfig(monitor.config);
    const gateEnabled = config.toggles.ask_tool_approval;

    const cached = digestCache.get(monitor.id);
    let digest: unknown;
    if (cached && Date.now() < cached.expiresAt) {
      digest = cached.digest;
    } else {
      digest = await buildDigest(sql, monitor.id);
      if (digestCache.size >= DIGEST_CACHE_MAX) {
        const oldest = digestCache.keys().next().value;
        if (oldest) digestCache.delete(oldest);
      }
      digestCache.set(monitor.id, { expiresAt: Date.now() + DIGEST_TTL_MS, digest });
    }

    const system = `You are the analyst for the "${monitor.name}" monitor in socialmonitor.
${config.context ? `Monitor context: ${config.context}\n` : ""}
Answer questions about what's being said across the monitored sources, grounded ONLY in the
digest below and tool results. Quote counts and unique-author numbers; link to originals with
markdown links when URLs are present. Theme counters labeled "lifetime" are all-time totals,
not per-window — say so when citing them. If the digest can't answer, call a tool. If the
data genuinely can't answer, say so — never invent items, counts, or quotes.

PRECOMPUTED DIGEST (30d unless noted):
${JSON.stringify(digest)}`;

    const client = new Anthropic({ apiKey });
    const model = config.model.narrate || process.env.NARRATE_MODEL || DEFAULT_NARRATE_MODEL;

    // History: cap, then trim so the first retained message is a user turn —
    // slice alone deterministically yields assistant-first at odd lengths.
    const history = body.messages.slice(-HISTORY_CAP);
    while (history.length > 0 && history[0]!.role !== "user") history.shift();
    if (history.length === 0) {
      return NextResponse.json({ error: "no user message in history" }, { status: 400 });
    }
    const messages: Anthropic.MessageParam[] = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const toolCalls: ToolCallRecord[] = [];
    let calls = 0;
    let inTok = 0;
    let outTok = 0;
    let cost = 0;

    const executeToolUses = async (toolUses: Anthropic.ToolUseBlock[]): Promise<void> => {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        let result: unknown;
        try {
          result = await runAskTool(sql, monitor.id, tu.name, tu.input as Record<string, unknown>);
        } catch (err) {
          result = { error: String(err) };
        }
        toolCalls.push({ name: tu.name, args: tu.input as Record<string, unknown>, result });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result).slice(0, 20_000),
        });
      }
      // All tool_result blocks in a single user message (parallel tool use rule).
      messages.push({ role: "user", content: results });
    };

    const finishUsage = async (): Promise<void> => {
      if (calls > 0) {
        try {
          await recordUsage(sql, monitor.id, calls, inTok, outTok, cost);
        } catch (err) {
          console.error("[ask] recordUsage failed", err);
        }
      }
    };

    // Approved resume: replay the paused assistant turn verbatim and execute
    // exactly the tool calls the user saw. The HMAC proves the turn came from
    // this server, not from arbitrary client JSON (audit #13).
    if (body.approveTools && body.pendingTurn) {
      if (!verifyTurnSig(monitor.id, body.pendingTurn, body.pendingTurnSig)) {
        return NextResponse.json({ error: "invalid approval token" }, { status: 400 });
      }
      const pending = body.pendingTurn as unknown as Anthropic.ContentBlockParam[];
      messages.push({ role: "assistant", content: pending });
      const toolUses = pending.filter(
        (b): b is Anthropic.ToolUseBlock => (b as { type?: string }).type === "tool_use",
      );
      if (toolUses.length === 0) {
        return NextResponse.json({ error: "pending turn had no tool calls" }, { status: 400 });
      }
      await executeToolUses(toolUses);
    }

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const finalRound = round === MAX_TOOL_ROUNDS;
      const response = await client.messages.create({
        model,
        // Adaptive thinking spends from max_tokens; 2000 produced empty
        // replies on real data volumes (audit #15).
        max_tokens: 8000,
        output_config: { effort: "low" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: ASK_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        })),
        // Force a text answer on the last round so the reply is never empty.
        ...(finalRound ? { tool_choice: { type: "none" as const } } : {}),
        messages,
      });

      calls++;
      inTok += response.usage.input_tokens;
      outTok += response.usage.output_tokens;
      cost += estimateCostUsd(model, response.usage as never, false);

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0 || finalRound) {
        await finishUsage();
        const reply = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        return NextResponse.json({
          reply: reply || "I couldn't produce an answer for that — try rephrasing.",
          toolCalls,
        });
      }

      if (gateEnabled) {
        // Pause EVERY round (audit #13): an approval covers exactly one turn —
        // the approved turn executed above, and any new tool call pauses again.
        await finishUsage();
        return NextResponse.json({
          reply: "",
          toolCalls,
          needsApproval: toolUses.map((t) => ({ name: t.name, args: t.input })),
          pendingTurn: response.content,
          pendingTurnSig: signTurn(monitor.id, response.content),
        });
      }

      messages.push({ role: "assistant", content: response.content });
      await executeToolUses(toolUses);
    }

    await finishUsage();
    return NextResponse.json({
      reply: "I ran out of tool rounds before reaching an answer — try a narrower question.",
      toolCalls,
    });
  } finally {
    await sql.end({ timeout: 3 });
  }
}
