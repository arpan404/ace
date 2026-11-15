import { glyph } from "../glyph.ts";
import { type Part, detail, shape } from "../parts.ts";

/** A hand closing to take hold; shared by Hand. */
export const grabbingHand = (): Part[] => [
  shape(
    "M7.1 13.5V8.8a1.3 1.3 0 0 1 2.6 0v-.75a1.3 1.3 0 0 1 2.6 0v.5a1.3 1.3 0 0 1 2.6 0v1a1.3 1.3 0 0 1 2.6 0v4.95c0 3.9-2.3 6.5-5.25 6.5-2.15 0-3.65-.9-4.85-2.6l-3.1-4.35a1.35 1.35 0 0 1 2.05-1.7Z",
  ),
  detail("M7.6 12.75h9.4M9.7 10v2.75M12.3 9.25v3.5M14.9 10.25v2.5"),
];

/** Take over: a hand closing to take hold. */
export const HandGrabbingIcon = /* @__PURE__ */ glyph("HandGrabbing", grabbingHand);
