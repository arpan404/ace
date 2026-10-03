import type { InteractionResolution } from "@ace/protocol";

/** Sends one answer to an open interaction. */
export type Answer = (resolution: InteractionResolution) => void;
