import { z } from "zod";
import { serveOffThread } from "@/lib/off-thread.ts";
import { markdownDoc } from "./blocks.ts";

// Lexing and highlighting for transcript prose, off the main thread (ADR 0056).
const Input = z.object({ text: z.string(), hash: z.string() });
serveOffThread(
  (input) => Input.parse(input),
  (input) => markdownDoc(input.text, input.hash),
);
