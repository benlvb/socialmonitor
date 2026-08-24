import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { createDb } from "@socialmonitor/db";
import { parseMonitorConfig } from "@socialmonitor/shared";
import { createClient } from "../../../lib/supabase/server";
import { ASK_TOOLS, buildDigest, runAskTool } from "../../../lib/ask-tools";

export const maxDuration = 120;

const MAX_TOOL_ROUNDS = 5;
const digestCache = new Map<string, { at: number; digest: unknown }>();
const DIGEST_TTL_MS = 5 * 60 * 1000;

interface AskRequest {
  monitorId: string;
  messages: { role: "user" | "assistant"; content: string }[];
  approveTools?: boolean;
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

/**
 * /ask (D17): digest-first, four read-only tools, auto-executed. When the
 * per-monitor approval gate is on, the first tool request pauses and returns
 * needsApproval; the client resends with approveTools=true.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await request.json()) as AskRequest;
  const { data: monitor } = await supabase
    .from("monitors")
    .select("id, name, config")
    .eq("id", body.monitorId)
    .single();
  if (!monitor) return NextResponse.json({ error: "monitor not found" }, { status: 404 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({
      reply:
        "The Anthropic API key isn't configured yet — plug it in on the Connections page to activate /ask.",
      toolCalls: [],
    });
  }
  const sql = createDb();
  if (!sql) return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 500 });

  try {
    const config = parseMonitorConfig(monitor.config);
    const gate = config.toggles.ask_tool_approval && !body.approveTools;

    const cached = digestCache.get(monitor.id);
    const digest =
      cached && Date.now() - cached.at < DIGEST_TTL_MS
        ? cached.digest
        : await buildDigest(sql, monitor.id);
    digestCache.set(monitor.id, { at: Date.now(), digest });

    const system = `You are the analyst for the "${monitor.name}" monitor in socialmonitor.
${config.context ? `Monitor context: ${config.context}\n` : ""}
Answer questions about what's being said across the monitored sources, grounded ONLY in the
digest below and tool results. Quote counts and unique-author numbers; link to originals with
markdown links when URLs are present. If the digest can't answer, call a tool. If the data
genuinely can't answer, say so — never invent items, counts, or quotes.

PRECOMPUTED DIGEST (30d unless noted):
${JSON.stringify(digest)}`;

    const client = new Anthropic();
    const model = config.model.narrate || process.env.NARRATE_MODEL || "claude-sonnet-5";
    const messages: Anthropic.MessageParam[] = body.messages.slice(-20).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const toolCalls: ToolCallRecord[] = [];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await client.messages.create({
        model,
        max_tokens: 2000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: ASK_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        })),
        messages,
      });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0 || round === MAX_TOOL_ROUNDS) {
        const reply = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        return NextResponse.json({ reply, toolCalls });
      }

      if (gate) {
        // Approval gate (off by default): stop before executing; client resends.
        return NextResponse.json({
          reply: "",
          toolCalls,
          needsApproval: toolUses.map((t) => ({ name: t.name, args: t.input })),
        });
      }

      messages.push({ role: "assistant", content: response.content });
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
    }

    return NextResponse.json({ reply: "(no answer produced)", toolCalls });
  } finally {
    await sql.end({ timeout: 3 });
  }
}
