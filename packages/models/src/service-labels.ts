/** Service names shared by discovery, settings and native sign-in choices. */
const labels: Readonly<Record<string, string>> = {
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode Zen",
  "opencode-zen": "OpenCode Zen",
  "github-copilot": "GitHub Copilot",
  copilot: "GitHub Copilot",
  "openai-codex": "ChatGPT / Codex",
  "openai-chatgpt": "ChatGPT / Codex",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "google-gemini-cli": "Gemini CLI",
  "google-antigravity": "Antigravity",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  "ollama-cloud": "Ollama Cloud",
  lmstudio: "LM Studio",
  "llama.cpp": "llama.cpp",
  other: "Other provider",
};
export function serviceLabel(id: string): string {
  return labels[id.toLowerCase()] ?? id;
}
