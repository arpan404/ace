/*
 * Adding an ACP agent the registry doesn't list: a name and the command that starts it. The
 * command is split the way a shell would split it, checked against what the daemon accepts for
 * a local binding (`registry.bind` with a `local:` identity), and shown back exactly as ace will
 * run it, so the person approves the real thing. Pure.
 */

/** A command line split into words, or null when a quote is left open. */
export function splitCommand(text: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && /["\\$`]/.test(text[index + 1] ?? "")) word += text[++index];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < text.length) {
      word += text[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

/** One word as a shell would need it typed. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Package runners fetch code at launch; the daemon binds only an installed entrypoint. */
const packageRunner = /^(?:npx|uvx|bunx|npm|pnpm|yarn|bun|uv)(?:-cli)?(?:\.(?:cmd|js|cjs|mjs))?$/;

export interface ManualAgent {
  name: string;
  acpAgentId: string;
  installationId: string;
  instanceId: string;
  version: string;
  command: string;
  args: string[];
  /** The command as ace will run it, for the approval. */
  display: string;
}

export type ManualAgentCheck =
  | { ok: true; agent: ManualAgent }
  | { ok: false; field: "name" | "command"; problem: string };

/** The binding for a named command, or what to fix first. */
export function manualAgent(name: string, command: string): ManualAgentCheck {
  const label = name.trim();
  if (!label) return { ok: false, field: "name", problem: "Give the agent a name." };
  if (label.length > 64) return { ok: false, field: "name", problem: "Use a shorter name." };
  const slug = label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return { ok: false, field: "name", problem: "Use letters or numbers in the name." };
  const text = command.trim();
  if (!text)
    return { ok: false, field: "command", problem: "Enter the command that starts the agent." };
  if ([...text].some((char) => char.charCodeAt(0) < 32 && char !== "\t"))
    return { ok: false, field: "command", problem: "Put the command on one line." };
  const words = splitCommand(text);
  if (!words) return { ok: false, field: "command", problem: "Close the quote in the command." };
  const [program, ...args] = words;
  if (!program || text.length > 4096 || args.length > 64)
    return { ok: false, field: "command", problem: "Use a shorter command." };
  if (packageRunner.test(program.split(/[\\/]/).at(-1) ?? ""))
    return {
      ok: false,
      field: "command",
      problem: "Use the agent's installed command, not a package runner like npx.",
    };
  const installationId = `local-${slug}`;
  return {
    ok: true,
    agent: {
      name: label,
      acpAgentId: `local:${slug}`,
      installationId,
      instanceId: `${installationId}:default`,
      version: "local",
      command: program,
      args,
      display: words.map(shellWord).join(" "),
    },
  };
}
