import { z } from "zod";
import { serveOffThread } from "@/lib/off-thread.ts";
import { markdownDoc } from "./blocks.ts";
import { codeLines } from "./code-lines.ts";

// Lexing and highlighting for transcript prose and for whole source files, off the main thread
// (ADR 0056).
const Input = z.union([
  z.object({ text: z.string(), hash: z.string() }),
  z.object({ code: z.string(), lang: z.string().optional(), hash: z.string() }),
]);
serveOffThread(
  (input) => Input.parse(input),
  (input) =>
    "code" in input
      ? codeLines(input.code, input.lang, input.hash)
      : markdownDoc(input.text, input.hash),
);
