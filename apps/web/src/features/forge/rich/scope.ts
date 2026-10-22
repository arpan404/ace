import { createContext } from "react";
import type { ForgeScope } from "./media-loads.ts";

/**
 * The project and repository whose forge text a page shows (a PR, an issue): where media in it
 * is resolved, and which host its links and mentions point at. Without one, media shows its
 * "Open on GitHub" fallback.
 */
export const ForgeContentScope = createContext<ForgeScope | undefined>(undefined);

/** Inside a link: an image there follows the link instead of opening the viewer. */
export const InsideLink = createContext(false);
