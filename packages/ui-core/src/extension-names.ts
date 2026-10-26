import type { CatalogEntry } from "@ace/protocol";

/** Words a slug spells in lowercase that people write another way. */
const words: Readonly<Record<string, string>> = {
  ace: "ace",
  ai: "AI",
  api: "API",
  apis: "APIs",
  aws: "AWS",
  ci: "CI",
  cli: "CLI",
  css: "CSS",
  db: "DB",
  dns: "DNS",
  e2e: "E2E",
  gcp: "GCP",
  graphql: "GraphQL",
  html: "HTML",
  http: "HTTP",
  id: "ID",
  ios: "iOS",
  js: "JS",
  json: "JSON",
  jwt: "JWT",
  llm: "LLM",
  macos: "macOS",
  mcp: "MCP",
  oauth: "OAuth",
  pdf: "PDF",
  pr: "PR",
  prs: "PRs",
  qa: "QA",
  sdk: "SDK",
  seo: "SEO",
  sql: "SQL",
  ssh: "SSH",
  svg: "SVG",
  tdd: "TDD",
  ts: "TS",
  tsx: "TSX",
  ui: "UI",
  url: "URL",
  ux: "UX",
  // Names of products and tools.
  android: "Android",
  anthropic: "Anthropic",
  antigravity: "Antigravity",
  bun: "Bun",
  claude: "Claude",
  clerk: "Clerk",
  cloudflare: "Cloudflare",
  codex: "Codex",
  cursor: "Cursor",
  docker: "Docker",
  electron: "Electron",
  figma: "Figma",
  git: "Git",
  github: "GitHub",
  gitlab: "GitLab",
  google: "Google",
  kubernetes: "Kubernetes",
  linear: "Linear",
  linux: "Linux",
  neon: "Neon",
  nextjs: "Next.js",
  node: "Node",
  openai: "OpenAI",
  opencode: "OpenCode",
  playwright: "Playwright",
  postgres: "Postgres",
  python: "Python",
  react: "React",
  rust: "Rust",
  sentry: "Sentry",
  slack: "Slack",
  sqlite: "SQLite",
  stripe: "Stripe",
  swift: "Swift",
  swiftui: "SwiftUI",
  tailwind: "Tailwind",
  typescript: "TypeScript",
  vercel: "Vercel",
  vitest: "Vitest",
  windows: "Windows",
  xcode: "Xcode",
  zod: "Zod",
};

/** Word pairs that read as one name: "claude-code" is Claude Code, "pre-commit" stays joined. */
const pairs: Readonly<Record<string, string>> = {
  "claude code": "Claude Code",
  "pre commit": "pre-commit",
  "vs code": "VS Code",
};

/** Names that begin in lowercase even at the start of a title. */
const lowercaseStart = /^(ace|iOS|macOS|pre-commit)\b/;

/** "agents-sdk" → "Agents SDK"; "git-guardrails-claude-code" → "Git guardrails Claude Code". */
function sentence(slug: string): string {
  const parts = slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const out: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const pair = pairs[`${parts[index]} ${parts[index + 1] ?? ""}`];
    if (pair) {
      out.push(pair);
      index++;
      continue;
    }
    const part = parts[index] ?? "";
    out.push(words[part] ?? part);
  }
  return capitalised(out.join(" "));
}

const capitalised = (text: string) =>
  lowercaseStart.test(text) ? text : text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A name for people, in sentence case. An authored title is kept as written (only its first
 * letter raised); a slug becomes words with acronyms and product names spelled as people write
 * them. Qualified invocation names remain unchanged for the provider.
 */
export function extensionDisplayName(name: string, title?: string, agentPlugin?: string): string {
  const authored = title?.trim();
  const slug = name.split(":").at(-1) || name;
  // A plugin's agent reads with its plugin first: "Engineering reviewer".
  if (agentPlugin)
    return authored ? `${sentence(agentPlugin)} ${authored}` : sentence(`${agentPlugin}-${slug}`);
  return authored ? capitalised(authored) : sentence(slug);
}

export function catalogDisplayName(
  entry: Pick<CatalogEntry, "name" | "title" | "kind" | "source">,
): string {
  const plugin =
    entry.source.plugin ?? (entry.name.includes(":") ? entry.name.split(":")[0] : undefined);
  return entry.kind === "builtin"
    ? entry.name
    : extensionDisplayName(entry.name, entry.title, entry.kind === "agent" ? plugin : undefined);
}
