import { glyph } from "../glyph.ts";
import { shape, type Part } from "../parts.ts";

/** A shield's outline; every shield icon shares it. */
export const shieldBody = (): Part =>
  shape(
    "M12 2.75 18.55 5.1a1.5 1.5 0 0 1 .95 1.4V11c0 4.9-3.2 8.25-7.5 10.25C7.7 19.25 4.5 15.9 4.5 11V6.5a1.5 1.5 0 0 1 .95-1.4Z",
  );

/** Protection: a shield. */
export const ShieldIcon = /* @__PURE__ */ glyph("Shield", () => [shieldBody()]);
