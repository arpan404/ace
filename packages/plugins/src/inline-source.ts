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

/** A byte page always contains complete UTF-8 code points, including small requested pages. */
export function inlinePage(text: string, offset: number, limit: number) {
  const bytes = Buffer.from(text);
  if (offset > bytes.length || (offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80))
    throw new Error("Source unavailable");
  let end = Math.min(bytes.length, offset + Math.max(4, limit));
  while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {
    bytes: bytes.length,
    offset,
    nextOffset: end,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)),
  };
}
