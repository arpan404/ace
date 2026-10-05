import { z } from "zod";
import { serveOffThread } from "@/lib/off-thread.ts";
import { codeLines } from "./code-lines.ts";
import { StreamRegistry } from "./stream-registry.ts";

// Lexing and highlighting for transcript prose and for whole source files, off the main thread
// (ADR 0056). Prose arrives as appends to a stream, so a growing message is lexed only from its
// last settled block on.
const Input = z.union([
  z.object({ stream: z.string(), at: z.number(), append: z.string(), final: z.boolean() }),
  z.object({ release: z.string() }),
  z.object({ code: z.string(), lang: z.string().optional(), hash: z.string() }),
]);
const streams = new StreamRegistry(() => performance.now());
serveOffThread(
  (input) => Input.parse(input),
  (input) =>
    "code" in input
      ? codeLines(input.code, input.lang, input.hash)
      : "release" in input
        ? streams.release(input.release)
        : streams.apply(input),
);
