import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * Providers and their accounts in the fake world (ADR 0214), as a person with several would
 * have them: OpenCode Go with its key; OpenRouter (added by its address in `fake-spade.ts`) that
 * 31 bots think with; OpenAI three times, an API key and two ChatGPT sign-ins, one of them at its
 * plan's usage limit until 4:10 PM; Anthropic added but with no key yet, so the two bots on it
 * can't run; and the Ollama on this computer (`fake-spade-models.ts`) with a model that failed
 * Spade's tool check. The other presets are there to add from.
 */

type Json = Record<string, unknown>;

const model = (id: string, name: string, context: number, capabilities: string[]): Json => ({
  id,
  name,
  context,
  capabilities,
  source: "listed",
});

const preset = (id: string, name: string, format: string, base_url: string, key_env: string) => ({
  id,
  name,
  format,
  base_url,
  key_env,
  session_header: null,
});

const account = (fields: Json): Json => ({
  provider: null,
  auth: "key",
  account: null,
  header_names: [],
  session_header: null,
  needs_key: true,
  key_set: true,
  key_source: "keychain",
  ...fields,
});

/** The next 4:10 PM here: when the fake's limited ChatGPT account comes back. */
function nextTenPastFour(now: number): number {
  const at = new Date(now);
  at.setHours(16, 10, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

const gpt62 = model("gpt-6.2", "GPT-6.2", 400_000, ["images", "tools", "reasoning"]);
const gpt62Mini = model("gpt-6.2-mini", "GPT-6.2 Mini", 400_000, ["images", "tools"]);

export function seedFakeAccounts(here: FakeSpadeApi, now: number): void {
  here.presets.push(
    {
      ...preset(
        "openai",
        "OpenAI",
        "openai-responses",
        "https://api.openai.com/v1/",
        "OPENAI_API_KEY",
      ),
      models: [gpt62],
    },
    {
      ...preset(
        "anthropic",
        "Anthropic",
        "anthropic",
        "https://api.anthropic.com/v1/",
        "ANTHROPIC_API_KEY",
      ),
      models: [
        model("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, ["images", "tools"]),
        model("claude-opus-5-5", "Claude Opus 5.5", 1_000_000, ["images", "tools"]),
      ],
    },
    preset(
      "google",
      "Google",
      "openai-chat",
      "https://generativelanguage.googleapis.com/v1beta/openai/",
      "GEMINI_API_KEY",
    ),
    preset(
      "moonshot",
      "Moonshot",
      "openai-chat",
      "https://api.moonshot.ai/v1/",
      "MOONSHOT_API_KEY",
    ),
    preset("zai", "Z.AI", "openai-chat", "https://api.z.ai/api/paas/v4/", "ZAI_API_KEY"),
  );
  here.endpoints.push(
    account({
      id: "opencode-go",
      name: "OpenCode Go",
      provider: "opencode-go",
      format: "openai-chat",
      base_url: "https://opencode.ai/zen/go/v1/",
      session_header: "x-opencode-session",
      models: [
        model("kimi-k3.1-pro", "Kimi K3.1 Pro", 262_000, ["images", "tools", "reasoning"]),
        model("glm-5.3", "GLM-5.3", 200_000, ["tools", "reasoning"]),
        model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 128_000, ["tools"]),
      ],
    }),
    account({
      id: "openai",
      name: "Personal",
      provider: "openai",
      format: "openai-responses",
      base_url: "https://api.openai.com/v1/",
      models: [{ ...gpt62, source: "preset" }, gpt62Mini],
    }),
    account({
      id: "chatgpt",
      name: "ChatGPT",
      provider: "openai",
      auth: "chatgpt",
      account: { email: "sam@example.com", plan: "pro", signed_in: true },
      format: "openai-responses",
      base_url: "https://chatgpt.com/backend-api/codex/",
      needs_key: false,
      key_set: false,
      key_source: null,
      models: [gpt62, model("gpt-6.2-codex", "GPT-6.2 Codex", 400_000, ["tools", "reasoning"])],
    }),
    account({
      id: "chatgpt-2",
      name: "Studio",
      provider: "openai",
      auth: "chatgpt",
      account: {
        email: "work@studio.dev",
        plan: "plus",
        signed_in: true,
        limited_until: nextTenPastFour(now),
      },
      format: "openai-responses",
      base_url: "https://chatgpt.com/backend-api/codex/",
      needs_key: false,
      key_set: false,
      key_source: null,
      models: [gpt62, gpt62Mini],
    }),
    account({
      id: "anthropic",
      name: "Anthropic",
      provider: "anthropic",
      format: "anthropic",
      base_url: "https://api.anthropic.com/v1/",
      key_set: false,
      key_source: null,
      models: [
        {
          ...model("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, ["images", "tools"]),
          source: "preset",
        },
      ],
    }),
  );
  // What each provider lists, for its Manage dialog: more than the person has turned on.
  here.liveModels.set("opencode-go", [
    model("kimi-k3.1-pro", "Kimi K3.1 Pro", 262_000, ["images", "tools", "reasoning"]),
    model("glm-5.3", "GLM-5.3", 200_000, ["tools", "reasoning"]),
    model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 128_000, ["tools"]),
    model("deepseek-v4.1", "DeepSeek V4.1", 128_000, ["tools", "reasoning"]),
    model("qwen3.6-coder-plus", "Qwen3.6 Coder Plus", 1_000_000, ["tools"]),
    model("minimax-m3", "MiniMax M3", 1_000_000, ["tools", "reasoning"]),
  ]);
  const routed = here.liveModels.get("openrouter");
  here.liveModels.set("openrouter", [
    ...(Array.isArray(routed) ? routed : []),
    model("openai/gpt-6.2", "GPT-6.2", 400_000, ["images", "tools", "reasoning"]),
    model("google/gemini-3.5-pro", "Gemini 3.5 Pro", 1_000_000, ["images", "tools"]),
    model("x-ai/grok-5", "Grok 5", 256_000, ["images", "tools"]),
    model("moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro", 262_000, ["images", "tools"]),
    model("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 128_000, ["tools"]),
    model("z-ai/glm-5.3", "GLM-5.3", 200_000, ["tools", "reasoning"]),
    model("qwen/qwen3.6-max", "Qwen3.6 Max", 256_000, ["tools", "reasoning"]),
    model("mistralai/devstral-3", "Devstral 3", 256_000, ["tools"]),
    model("minimax/minimax-m3", "MiniMax M3", 1_000_000, ["tools", "reasoning"]),
  ]);
  const chatgptLive = [
    model("gpt-6.2-sol", "GPT-6.2-Sol", 500_000, ["images", "tools", "reasoning"]),
    model("gpt-6.2-astra", "GPT-6.2-Astra", 272_000, ["images", "tools", "reasoning"]),
    model("gpt-6.1-terra", "GPT-6.1 Terra", 500_000, ["images", "tools", "reasoning"]),
    model("gpt-6.1-sol", "GPT-6.1-Sol", 500_000, ["images", "tools", "reasoning"]),
    model("gpt-6-astra", "GPT-6-Astra", 272_000, ["images", "tools", "reasoning"]),
    model("gpt-6-sol", "GPT-6-Sol", 272_000, ["images", "tools", "reasoning"]),
    model("gpt-6-luna", "GPT-6-Luna", 272_000, ["images", "tools", "reasoning"]),
  ];
  here.liveModels.set("openai", [...chatgptLive]);
  here.liveModels.set("chatgpt", chatgptLive);
  here.liveModels.set("chatgpt-2", chatgptLive);
  here.liveModels.set("anthropic", [
    model("claude-opus-5-5", "Claude Opus 5.5", 1_000_000, ["images", "tools"]),
    model("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, ["images", "tools"]),
    model("claude-haiku-5-5", "Claude Haiku 5.5", 200_000, ["images", "tools"]),
  ]);
  // The next sign-in in the fake is someone else's ChatGPT, so it adds another account.
  here.accounts.signInAs = { email: "sam@work.example", plan: "team" };
  const flights = here.agents.find((agent) => agent.id === "flights");
  if (flights) flights.model = "chatgpt/gpt-6.2";
  // Two bots wait on Anthropic's missing key; two think with the limited ChatGPT account.
  for (const [id, name, task, on] of [
    ["digest", "Digest", "Send me a digest of the day's mail at 6 PM.", "anthropic"],
    ["triage", "Triage", "Sort new issues by area and flag anything urgent.", "anthropic"],
    ["studio-standup", "Studio standup", "Write my standup from yesterday's commits.", "chatgpt-2"],
  ] as const)
    here.addAgent({
      id,
      name,
      task,
      model: on === "anthropic" ? "anthropic/claude-sonnet-5-5" : "chatgpt-2/gpt-6.2",
    });
  here.addAgent({
    id: "go-coder",
    name: "Refactor helper",
    task: "Tidy the modules I name, one pull request each.",
    model: "opencode-go/kimi-k3.1-pro",
  });
}
