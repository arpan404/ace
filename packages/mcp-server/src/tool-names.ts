import { bareToolName } from "@ace/provider-kit/ace-tool-names";

export { bareToolName };

/**
 * Registered tool names: bare lowercase snake case. The server name `ace` is the namespace
 * every provider adds (`mcp__ace__context`, `ace_context`), so a name never repeats it. The
 * registry still accepts a toolkit that has not dropped its old `ace_` prefix, and compares
 * names in bare form so both spellings reach one tool.
 */
export const toolNamePattern = /^[a-z][a-z0-9_]{0,100}$/;

/**
 * The guide topic of a tool registered without one: the browser, screen and device toolkits
 * name their tools by family. Any other undeclared tool has no family and is always listed,
 * so a new toolkit is never silently hidden behind an unrelated guide.
 */
export function defaultToolset(name: string): string | undefined {
  const bare = bareToolName(name);
  if (bare.startsWith("browser_")) return "ace-browser";
  if (bare.startsWith("screen_") || bare.startsWith("sim_")) return "ace-computer-use";
  return undefined;
}

/** A readable title for a tool registered without one: `thread_read` reads "Thread read". */
export function defaultToolTitle(name: string): string {
  const words = bareToolName(name).replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
