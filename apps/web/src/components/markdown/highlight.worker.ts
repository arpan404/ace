import { z } from "zod";
import { serveOffThread } from "@/lib/off-thread.ts";
import { codeLines } from "./code-lines.ts";
const Input = z.object({ code: z.string(), lang: z.string().optional(), hash: z.string() });
serveOffThread(
  (input) => Input.parse(input),
  (input) => codeLines(input.code, input.lang, input.hash),
);
