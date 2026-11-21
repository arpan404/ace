import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * Models the person controls, in the fake world (ADR 0205): an Ollama on this computer the
 * picker offers first, the subscriptions' terms as Spade's record reads them (every provider
 * unclear until its record is written), a bot whose subscription's maker no longer allows it,
 * and a bot whose route moved a step to its next model. Spade's checks on the local models
 * (ADR 0205 §3): Qwen3 called the fake tool and ace measured its family; Gemma's small model
 * didn't, so it writes titles and summaries only. Helpers and bots' fallbacks have routes.
 */

const acknowledgement = (name: string) =>
  `This bot will run in your ${name} CLI on your subscription. Its maker's terms apply to how ` +
  "you use it. If they change, Spade may stop offering it. Its terms don't say whether this " +
  "is allowed.";

export function seedFakeModelAccess(here: FakeSpadeApi, minutes: (count: number) => number): void {
  here.endpoints.unshift({
    id: "ollama",
    name: "Ollama",
    format: "openai-chat",
    base_url: "http://127.0.0.1:11434/v1/",
    local: true,
    header_names: [],
    session_header: null,
    needs_key: false,
    key_set: false,
    key_source: null,
    models: [
      {
        id: "qwen3:8b",
        name: "Qwen3 8B",
        context: 128_000,
        capabilities: ["tools"],
        source: "listed",
        probes: {
          state: "checked",
          at_ms: minutes(60),
          plain: "passed",
          tools: "passed",
          structured: "passed",
          why: null,
        },
        known_good: { name: "Qwen3", passed: 0.92, cases: 48, checked: "2026-11-18" },
      },
      {
        id: "gemma3:1b",
        name: "Gemma 3 1B",
        context: 32_000,
        capabilities: [],
        source: "listed",
        probes: {
          state: "checked",
          at_ms: minutes(30),
          plain: "passed",
          tools: "failed",
          structured: "passed",
          why: "This model didn't call tools in Spade's check, so it can't run a bot.",
        },
        known_good: null,
      },
    ],
  });
  here.roles.global.title = "ollama/gemma3:1b";
  here.roles.globalRoutes = {
    main: ["ollama/qwen3:8b", "openrouter/anthropic/claude-sonnet-5.5"],
    helper: ["ollama/qwen3:8b", "openrouter/anthropic/claude-haiku-5.5"],
    title: ["ollama/gemma3:1b"],
  };
  here.roles.global.helper = "ollama/qwen3:8b";
  for (const subscription of here.subscriptions)
    subscription.terms = {
      status: "unclear",
      acknowledgement: acknowledgement(String(subscription.name)),
      acknowledged: false,
    };
  const refusal = "Claude Code's terms no longer allow this. Pick another model for this bot.";
  const ledger = here.addAgent({
    id: "ledger",
    name: "Ledger",
    model: "cli:claude/opus-5.5",
    problem: refusal,
    terms_hold: {
      provider: "claude",
      name: "Claude Code",
      text: refusal,
      choices: ["ollama/qwen3:8b", "openrouter/anthropic/claude-sonnet-5.5"],
    },
    avatar: {
      kind: "character",
      v: 1,
      body: "blob",
      pair: "sky",
      ears: "none",
      marking: "none",
      eyes: "round",
      mouth: "smile",
      cheeks: "none",
      accessory: "glasses",
    },
    last_activity: minutes(5),
    last_message: {
      from: "person",
      text: "Add the hardware store receipt",
      at: minutes(5),
      from_agent: null,
    },
  });
  here.store(ledger.conversation, {
    type: "user_message",
    text: "Add the hardware store receipt",
  });
  const logs = here.addAgent({
    id: "logs",
    name: "Logs",
    model: "ollama/qwen3:8b",
    avatar: {
      kind: "character",
      v: 1,
      body: "bot",
      pair: "butter",
      ears: "none",
      marking: "none",
      eyes: "egg",
      mouth: "none",
      cheeks: "none",
      accessory: "none",
    },
    last_activity: minutes(2),
  });
  here.store(logs.conversation, {
    type: "user_message",
    text: "Anything odd in last night's logs?",
  });
  here.store(logs.conversation, { type: "reply_started", reply: "r-logs" });
  here.store(logs.conversation, {
    type: "step_served",
    reply: "r-logs",
    model: "openrouter/anthropic/claude-sonnet-5.5",
    skipped: [{ model: "ollama/qwen3:8b", reason: "unreachable" }],
    line: "Ran on Claude Sonnet 5.5: the local server was off.",
  });
  const answer =
    "Two things stood out: the backup job retried three times around 02:10, and the disk on " +
    "the build server crossed 85% at 03:40. Nothing else changed from the night before.";
  here.store(logs.conversation, { type: "step_finished", reply: "r-logs", text: answer });
  here.store(logs.conversation, { type: "reply_finished", reply: "r-logs", text: answer });
}
