import { z } from "zod";

const position = z.object({
  updatedAt: z.number().int().nonnegative().safe(),
  startedAt: z.number().int().nonnegative().safe(),
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
});
export type RunPosition = z.infer<typeof position>;

export function runCursor(run: RunPosition): string {
  const value = position.parse(run);
  return `page.${value.updatedAt}.${value.startedAt}.${value.id}`;
}
export function cursorPosition(cursor: string): RunPosition | undefined {
  const parts = /^page\.([0-9]+)\.([0-9]+)\.(.+)$/.exec(cursor);
  return parts
    ? position.parse({ updatedAt: Number(parts[1]), startedAt: Number(parts[2]), id: parts[3] })
    : undefined;
}
export function compareRuns(a: RunPosition, b: RunPosition): number {
  return (
    b.updatedAt - a.updatedAt ||
    b.startedAt - a.startedAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
