import { z } from "zod";
import { WorkspaceError, type Match } from "./types.ts";

const envelope = z.looseObject({ type: z.string().optional() });
const matchEvent = z.looseObject({
  data: z.looseObject({
    line_number: z.number().int().positive(),
    lines: z.looseObject({ text: z.string().optional(), bytes: z.string().optional() }),
    submatches: z.array(z.looseObject({ start: z.number().int().nonnegative() })),
  }),
});
export function rgMatches(line: string, path: string, limit: number): Match[] {
  try {
    const event = envelope.parse(JSON.parse(line));
    if (event.type !== "match") return [];
    const { data } = matchEvent.parse(event);
    const preview = (
      data.lines.text ?? Buffer.from(data.lines.bytes ?? "", "base64").toString("utf8")
    )
      .replace(/\r?\n$/, "")
      .slice(0, 512);
    return data.submatches.slice(0, limit).map((match) => ({
      path,
      line: data.line_number,
      column: match.start + 1,
      preview,
    }));
  } catch (error) {
    throw new WorkspaceError("SEARCH_FAILED", "Malformed ripgrep match event", error);
  }
}
export const workerResponse = z.union([
  z.object({
    matches: z
      .array(
        z.object({
          path: z.string(),
          line: z.number().int().positive(),
          column: z.number().int().positive(),
          preview: z.string().max(512),
        }),
      )
      .max(10_000),
  }),
  z.object({ error: z.string() }),
]);
