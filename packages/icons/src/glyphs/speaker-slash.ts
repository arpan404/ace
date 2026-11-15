import { glyph } from "../glyph.ts";
import { slashed } from "../parts.ts";
import { speaker } from "./speaker-high.ts";

/** Muted: the speaker, centred, crossed out. */
export const SpeakerSlashIcon = /* @__PURE__ */ glyph("SpeakerSlash", () => slashed(speaker(3)));
