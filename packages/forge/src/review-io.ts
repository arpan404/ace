import type { z } from "zod";
import type { GhApi, Page } from "./http.ts";
import { ForgeError } from "./errors.ts";

/** What hosted review writers share: one PR-scoped request path and paged record reads. */
export type ReviewIo = {
  /** `repos/{owner}/{name}` of the PR's base repository. */
  readonly root: string;
  request(...args: Parameters<GhApi["request"]>): Promise<Page>;
  records<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T[]>;
  /** The PR's own comment with this id, or undefined when it isn't one of the PR's. */
  comment(
    number: number,
    source: "inline" | "issue",
    id: number,
    signal: AbortSignal,
  ): Promise<{ id: number; body: string; node_id?: string | undefined } | undefined>;
};

export function decode<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ForgeError("invalid_data");
  return result.data;
}
