import { glyph } from "../glyph.ts";
import { dot } from "../parts.ts";
import { tablet } from "./device-tablet.ts";

/** An Android tablet: a tablet with a round camera at the top. */
export const DeviceTabletCameraIcon = /* @__PURE__ */ glyph("DeviceTabletCamera", () => [
  ...tablet(),
  dot(12, 6, 1.1),
]);
