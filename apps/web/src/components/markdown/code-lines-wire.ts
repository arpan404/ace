import { z } from "zod";
import type { CodeLines } from "./code-lines.ts";
import type { CodeToken } from "./highlight.ts";

/** Same-build worker token graphs are checked shallowly; plain results carry no source. */
export const CodeLinesReply = z.union([
  z.object({ hash: z.string(), plain: z.literal(true) }),
  z.object({ hash: z.string(), lines: z.custom<CodeToken[][]>(Array.isArray) }),
]) satisfies z.ZodType<CodeLines>;
