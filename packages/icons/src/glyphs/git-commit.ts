import { glyph } from "../glyph.ts";
import { circle, line } from "../parts.ts";

/** A commit: one node on the line. */
export const GitCommitIcon = /* @__PURE__ */ glyph("GitCommit", () => [
  line(circle(12, 12, 2.5)),
  line("M2.75 12h6.75M14.5 12h6.75"),
]);
