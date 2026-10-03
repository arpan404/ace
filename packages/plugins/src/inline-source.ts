import { createHash } from "node:crypto";
import { z } from "zod";
import { PluginName } from "@ace/protocol/plugins";
import { parseJson, limits } from "./manifest.ts";

const manifest = z
  .object({
    commands: z.record(
      PluginName,
      z
        .object({
          content: z.string().max(limits.json).optional(),
          source: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Resolve virtual command text back to its owning native manifest, preserving unknown fields. */
export function inlineSource(files: Record<string, string>, path: string) {
  const match = /^\.ace-inline\/commands\/([^/]+)\.md$/.exec(path);
  if (!match) return undefined;
  const name = PluginName.parse(match[1]);
  const manifestPath = [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
  ].find((candidate) => files[candidate] !== undefined);
  if (!manifestPath || files["ace-plugin.json"] !== undefined || files["plugin.json"] !== undefined)
    return undefined;
  const parsed = manifest.parse(parseJson(files[manifestPath] ?? ""));
  const command = parsed.commands[name];
  if (!command || command.source !== undefined || command.content === undefined) return undefined;
  const text = command.content;
  return {
    path: manifestPath,
    text,
    hash: createHash("sha256").update(text).digest("hex"),
    replace: (content: string) =>
      JSON.stringify(
        {
          ...parsed,
          commands: { ...parsed.commands, [name]: { ...command, content } },
        },
        null,
        2,
      ) + "\n",
  };
}
