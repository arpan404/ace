import { glyph } from "../glyph.ts";
import { circle, line, shape } from "../parts.ts";

/** A review still to come: a person in a dashed ring. */
export const UserCircleDashedIcon = /* @__PURE__ */ glyph("UserCircleDashed", () => [
  line(circle(12, 12, 9.25), { dashed: true }),
  shape(circle(12, 9.75, 3)),
  shape("M7.75 17.6c.9-1.45 2.4-2.3 4.25-2.3s3.35.85 4.25 2.3Z"),
]);
