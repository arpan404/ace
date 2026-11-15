import { glyph } from "../glyph.ts";
import { dot } from "../parts.ts";
import { phone } from "./device-mobile.ts";

/** An Android phone: a phone with a round camera hole at the top. */
export const DeviceMobileCameraIcon = /* @__PURE__ */ glyph("DeviceMobileCamera", () => [
  ...phone(),
  dot(12, 6, 1.1),
]);
