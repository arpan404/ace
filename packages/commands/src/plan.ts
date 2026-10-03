import { expandTemplate } from "./template.ts";
import {
  CommandPlan,
  PromptArguments,
  type CommandResolution,
  type ProviderKind,
  type PromptValue,
} from "@ace/protocol";
import { z } from "zod";
import type { Definition } from "./types.ts";
const positions = z.array(z.string().max(16384)).max(64);
const failure = (
  error: Extract<CommandResolution, { ok: false }>["error"],
  argument?: string,
): CommandResolution => ({ ok: false, error, ...(argument === undefined ? {} : { argument }) });
const quote = (value: PromptValue) =>
  typeof value === "string" && !/^[\w./:-]+$/.test(value) ? JSON.stringify(value) : String(value);

export function resolveCommand(
  command: Definition,
  input: unknown,
  positional: unknown,
  provider: ProviderKind,
): CommandResolution {
  const args = PromptArguments.safeParse(input);
  const pos = positions.safeParse(positional);
  if (!args.success || !pos.success) return failure("invalid_argument");
  if (command.provider !== "any" && command.provider !== provider)
    return failure("unsupported_provider");
  if (command.unavailable) return failure("unsupported_command");
  const values = new Map<string, PromptValue>(Object.entries(args.data));
  if (command.format === "library" || command.format === "ace") {
    for (const key of values.keys())
      if (!Object.hasOwn(command.arguments, key)) return failure("invalid_argument", key);
    for (const [key, spec] of Object.entries(command.arguments)) {
      const value = values.get(key) ?? spec.default;
      if (value === undefined) {
        if (spec.required) return failure("missing_argument", key);
      } else if (typeof value !== spec.type) return failure("invalid_argument", key);
      else values.set(key, value);
    }
  }
  let plan: CommandPlan;
  if (command.format === "ace")
    plan = {
      kind: "ace",
      action: command.name,
      arguments: Object.fromEntries(values),
      positional: pos.data,
    };
  else if (command.format === "library") {
    if (pos.data.length) return failure("invalid_argument");
    let missing: string | undefined;
    const text = expandTemplate(
      command.body,
      /\\\{\{([\w.:-]+)\}\}|\{\{([\w.:-]+)\}\}/g,
      (match) => {
        const escaped = match[1],
          key = match[2];
        if (escaped !== undefined) return `{{${escaped}}}`;
        if (key === undefined) return "";
        if (!Object.hasOwn(command.arguments, key)) missing = key;
        return values.get(key) === undefined ? "" : String(values.get(key));
      },
    );
    if (missing !== undefined) return failure("invalid_argument", missing);
    if (text === undefined) return failure("limit_exceeded");
    plan = { kind: "prompt", provider, text };
  } else if (command.format === "codex") {
    let missing: string | undefined;
    const joined = pos.data.join(" ");
    const text = expandTemplate(
      command.body,
      /\$\$|\$ARGUMENTS\b|\$[1-9]\b|\$[A-Z][A-Z0-9_]*\b/g,
      (match) => {
        const token = match[0];
        if (token === "$$") return "$";
        if (token === "$ARGUMENTS") return joined;
        if (/^\$[1-9]$/.test(token)) return pos.data[Number(token.slice(1)) - 1] ?? "";
        const key = token.slice(1);
        if (values.get(key) === undefined) {
          missing = key;
          return "";
        }
        return String(values.get(key));
      },
    );
    if (missing !== undefined) return failure("missing_argument", missing);
    if (text === undefined) return failure("limit_exceeded");
    plan = { kind: "prompt", provider, text };
  } else {
    const suffix = [
      ...pos.data.map(quote),
      ...Array.from(values).map(([key, value]) => `${key}=${quote(value)}`),
    ].join(" ");
    plan = {
      kind: "native",
      provider,
      text: `/${command.nativeName}${suffix ? ` ${suffix}` : ""}`,
      metadata: command.raw,
    };
  }
  const checked = CommandPlan.safeParse(plan);
  return checked.success ? { ok: true, plan: checked.data } : failure("limit_exceeded");
}
