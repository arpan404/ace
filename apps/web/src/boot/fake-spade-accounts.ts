import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * Providers and their accounts in the fake world (ADR 0214): OpenAI twice, once by an API key and
 * once by a ChatGPT sign-in that Flights thinks with, and an OpenCode Go account with no key yet.
 * The presets OpenAI and Anthropic are there to add more accounts from.
 */

const gpt = (id: string, name: string) => ({
  id,
  name,
  context: 400_000,
  capabilities: ["images", "tools"],
  source: "listed",
});

export function seedFakeAccounts(here: FakeSpadeApi): void {
  here.presets.push(
    {
      id: "openai",
      name: "OpenAI",
      format: "openai-responses",
      base_url: "https://api.openai.com/v1/",
      key_env: "OPENAI_API_KEY",
      session_header: null,
      models: [gpt("gpt-5.5", "GPT-5.5")],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      format: "anthropic",
      base_url: "https://api.anthropic.com/v1/",
      key_env: "ANTHROPIC_API_KEY",
      session_header: null,
    },
  );
  here.endpoints.push(
    {
      id: "openai",
      name: "Personal",
      provider: "openai",
      auth: "key",
      account: null,
      format: "openai-responses",
      base_url: "https://api.openai.com/v1/",
      header_names: [],
      session_header: null,
      needs_key: true,
      key_set: true,
      key_source: "keychain",
      models: [{ ...gpt("gpt-5.5", "GPT-5.5"), source: "preset" }],
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      provider: "openai",
      auth: "chatgpt",
      account: { email: "sam@example.com", plan: "pro", signed_in: true },
      format: "openai-responses",
      base_url: "https://chatgpt.com/backend-api/codex/",
      header_names: [],
      session_header: null,
      needs_key: false,
      key_set: false,
      key_source: null,
      models: [gpt("gpt-5.5", "GPT-5.5"), gpt("gpt-5.5-mini", "GPT-5.5 Mini")],
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      provider: "opencode-go",
      auth: "key",
      account: null,
      format: "openai-chat",
      base_url: "https://opencode.ai/zen/go/v1/",
      header_names: [],
      session_header: "x-opencode-session",
      needs_key: true,
      key_set: false,
      key_source: null,
      models: [{ id: "kimi-k2", name: "Kimi K2", source: "preset" }],
    },
  );
  // The next sign-in in the fake is someone else's ChatGPT, so it adds a second account.
  here.accounts.signInAs = { email: "sam@work.example", plan: "team" };
  const flights = here.agents.find((agent) => agent.id === "flights");
  if (flights) flights.model = "chatgpt/gpt-5.5";
}
