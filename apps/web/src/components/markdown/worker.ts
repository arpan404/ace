import type { Token } from "marked";
import { z } from "zod";
import { offThread } from "@/lib/off-thread.ts";
import type { CodeToken } from "./highlight.ts";
import { StreamRegistry, type StreamJob, type StreamReply } from "./stream-registry.ts";

/** A job for the markdown worker: text appended to a message, or a stream to release. */
export type MarkdownJob = StreamJob | { release: string };

/** In place, where there is no worker. */
export const localStreams = new StreamRegistry(() => performance.now());

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
/** A lexer token: an object with a type and its raw source. Its children render defensively. */
const LexerToken = z.custom<Token>(
  (value) => isObject(value) && typeof value.type === "string" && typeof value.raw === "string",
);
const Code = z.object({
  kind: z.enum(["plain", "keyword", "string", "number", "comment", "punct"]),
  text: z.string(),
}) satisfies z.ZodType<CodeToken>;
const Block = z.object({ token: LexerToken, code: z.array(Code).optional() });
/** What the worker answers. */
const Reply = z.union([
  z.object({
    from: z.number().int().nonnegative(),
    settled: z.array(Block),
    open: z.array(Block),
    ms: z.number(),
    mathSeen: z.boolean(),
  }),
  z.object({ resync: z.literal(true) }),
  z.null(),
]);

/** One markdown worker for transcript prose. */
export const markdownWorker = offThread<MarkdownJob, StreamReply | null>({
  spawn: () =>
    new Worker(new URL("./markdown.worker.ts", import.meta.url), {
      type: "module",
      name: "ace-markdown",
    }),
  local: (job) => ("release" in job ? localStreams.release(job.release) : localStreams.apply(job)),
  decode: (output) => Reply.parse(output),
});
