import { glyph } from "../glyph.ts";
import { circle, detail, shape } from "../parts.ts";

/** A location: a map pin with its round head. */
export const MapPinIcon = /* @__PURE__ */ glyph("MapPin", () => [
  shape("M12 21.5c-.4 0-7.25-5.9-7.25-11.75a7.25 7.25 0 0 1 14.5 0C19.25 15.6 12.4 21.5 12 21.5Z"),
  detail(circle(12, 9.75, 2.5)),
]);
