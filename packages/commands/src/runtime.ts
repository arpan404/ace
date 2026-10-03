import { dataWeight } from "./limits.ts";
import { z } from "zod";
import { PaletteName } from "@ace/protocol";
import type { ParsedSource, Target, Definition } from "./types.ts";
const entry = z
  .object({
    name: PaletteName,
    description: z.string().max(2048).default(""),
    input: z
      .object({ hint: z.string().max(1024) })
      .passthrough()
      .nullable()
      .optional(),
    argumentHint: z.string().max(1024).optional(),
  })
  .passthrough();
const claude = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    slash_commands: z.array(z.unknown()).max(512),
    skills: z.array(z.string()).max(512).optional(),
    terminal_slash_commands: z.array(z.string()).max(512).default([]),
  })
  .passthrough();
const acp = z
  .object({
    sessionUpdate: z.literal("available_commands_update"),
    availableCommands: z.array(z.unknown()).max(512),
  })
  .passthrough();
/** Adapters feed the Claude init or ACP update body. Unknown fields stay in raw metadata. */
export function parseRuntime(input: unknown, target: Target): ParsedSource {
  const source = `runtime:${target.session}`;
  if (dataWeight(input) === undefined)
    return {
      commands: [],
      diagnostics: [{ source, message: "Runtime command metadata limit exceeded" }],
    };
  const init = target.provider === "claude" ? claude.safeParse(input) : undefined;
  const update = acp.safeParse(input);
  const items = init?.success
    ? init.data.slash_commands
    : update.success
      ? update.data.availableCommands
      : undefined;
  if (!items)
    return {
      commands: [],
      diagnostics: [{ source, message: "Unrecognized runtime command list" }],
    };
  const result: ParsedSource = { commands: [], diagnostics: [] };
  for (const item of items) {
    const parsed = entry.safeParse(typeof item === "string" ? { name: item } : item);
    if (!parsed.success) {
      result.diagnostics.push({ source, message: "Invalid runtime command entry" });
      continue;
    }
    const v = parsed.data;
    const hint = v.argumentHint ?? v.input?.hint;
    const d: Definition = {
      id: `${source}#${v.name}`,
      name: v.name,
      nativeName: v.name,
      description: v.description,
      namespace: "provider",
      provider: target.provider,
      instance: target.instance,
      session: target.session,
      arguments: {},
      scope: "runtime",
      body: "",
      format: "runtime",
      raw: v,
      priority: 30,
      ...(hint === undefined ? {} : { argumentHint: hint }),
      ...(init?.success && init.data.terminal_slash_commands.includes(v.name)
        ? { unavailable: true }
        : {}),
    };
    result.commands.push(d);
  }
  return result;
}
