import { z } from "zod";
import { serveOffThread } from "@/lib/off-thread.ts";
import { StreamRegistry } from "./stream-registry.ts";

// Lexing for transcript prose off the main thread (ADR 0056). Prose arrives as appends to a
// stream, so a growing message is lexed only from its last settled block on. Syntax colors
// come from markit's worker on the main thread (highlight-jobs.ts).
const Input = z.union([
  z.object({ stream: z.string(), at: z.number(), append: z.string(), final: z.boolean() }),
  z.object({ release: z.string() }),
]);
const streams = new StreamRegistry(() => performance.now());
serveOffThread(
  (input) => Input.parse(input),
  (input) => ("release" in input ? streams.release(input.release) : streams.apply(input)),
);
