import { glyph } from "../glyph.ts";
import { arrowhead, polyline } from "../geometry.ts";
import { circle, line } from "../parts.ts";

/** A pull request: a branch asking to come back. */
export const GitPullRequestIcon = /* @__PURE__ */ glyph("GitPullRequest", () => [
  line(circle(6, 5.5, 2.5)),
  line(circle(6, 18.5, 2.5)),
  line(circle(18, 18.5, 2.5)),
  line("M6 8v8"),
  line(
    polyline([
      [18, 16],
      [18, 6, 3.5],
      [11.5, 6],
    ]),
  ),
  line(arrowhead([11.5, 6], 180, 3.2)),
]);
