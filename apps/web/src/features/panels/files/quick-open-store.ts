import { LocalStore } from "../store.ts";

/**
 * Which thread's quick-open palette is showing (⌘P), if any. A module store, so the shortcut
 * (registered with the tab kinds) and the palette (an overlay of the thread screen) meet
 * without either importing the other's code.
 */
export const quickOpen = new LocalStore<string | undefined>(undefined);
