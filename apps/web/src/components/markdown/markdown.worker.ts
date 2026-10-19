import { z } from "zod";
import { serveOffThread } from "@/lib/off-thread.ts";
import { codeLines } from "./code-lines.ts";
import { renderSettledMath } from "./math-worker.ts";
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
  async (input) => {
    if ("code" in input) return codeLines(input.code, input.lang, input.hash);
    if ("release" in input) return streams.release(input.release);
    const reply = streams.apply(input);
    // Settled formulas render here, once, off the main thread; the main thread
    // only inserts the shipped HTML.
    if (!("resync" in reply)) await renderSettledMath(reply.settled);
    return reply;
  },
);
