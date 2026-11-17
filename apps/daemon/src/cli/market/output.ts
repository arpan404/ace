import { readFile } from "node:fs/promises";
import type { Renderer } from "../io.ts";
import {
  discoverLines,
  entryLines,
  installedLines,
  publisherLines,
  publishLines,
  searchLines,
  sourceLines,
} from "../render/market.ts";
import type { MarketAnswer } from "./request.ts";

/*
 * What a market command prints: with `--json` the answer's data unchanged (no `op` envelope,
 * ADR 0178 §3), for a person the sentences in `render/market.ts`, for `--quiet` the ids.
 */

export interface Printed {
  readonly value: unknown;
  readonly render: Renderer<unknown>;
}

const lines = (text: readonly string[]): Renderer<unknown> => ({ human: () => text });

export function printed(answer: MarketAnswer): Printed {
  switch (answer.op) {
    case "discover":
      return { value: answer.discover, render: lines(discoverLines(answer.discover)) };
    case "search": {
      const { op: _op, ...value } = answer;
      return {
        value,
        render: {
          human: () => searchLines(answer),
          quiet: () => answer.entries.map((entry) => `${entry.type}/${entry.name}`),
        },
      };
    }
    case "read":
      return {
        value: { kind: "entry", entry: answer.entry },
        render: lines(entryLines(answer.entry)),
      };
    case "publisher":
      return {
        value: { kind: "publisher", page: answer.page },
        render: lines(publisherLines(answer.page)),
      };
    case "installed":
      return {
        value: { installed: answer.installed },
        render: {
          human: () => installedLines(answer.installed),
          quiet: () => answer.installed.map((entry) => `${entry.type}/${entry.name}`),
        },
      };
    case "sources":
      return {
        value: { sources: answer.sources },
        render: {
          human: () => sourceLines(answer.sources),
          quiet: () => answer.sources.map((s) => s.id),
        },
      };
    case "done":
      return {
        value: { ok: true, ...(answer.installed ? { installed: answer.installed } : {}) },
        render: { human: () => ["Done."], quiet: () => [] },
      };
    case "publish":
      return {
        value: answer.answer,
        render: {
          human: () => publishLines(answer.answer),
          quiet: () =>
            answer.answer.kind === "draft"
              ? [answer.answer.draft.id]
              : answer.answer.kind === "me"
                ? answer.answer.me.drafts.map((draft) => draft.id)
                : [],
        },
      };
    default: {
      const { op: _op, ...value } = answer;
      return { value, render: {} };
    }
  }
}

/**
 * A text argument: itself, `-` for stdin, or `@FILE` for a file's contents. Stdin is read only
 * when asked for with `-` (ADR 0178 §9).
 */
export async function readText(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (value === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trimEnd();
  }
  if (value.startsWith("@")) return (await readFile(value.slice(1), "utf8")).trimEnd();
  return value;
}
