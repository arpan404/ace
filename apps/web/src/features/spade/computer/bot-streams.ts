import type { ScreenInput } from "@ace/protocol";
import { createContext, use } from "react";

/*
 * The live pictures of a bot's browser and screen, and the person's input while they drive. They
 * come from the daemon (ace's browser and computer-use streams), which the app supplies here;
 * where none is supplied the views say the live picture isn't available.
 */

export type BotPictureSurface = "browser" | "screen";

export interface BotSurfaceKey {
  /** The machine key the bot runs on (`spadeMachineKey`). */
  machine: string;
  bot: string;
  surface: BotPictureSurface;
}

/** One picture: something an `<img>` can show, and its size in pixels. */
export interface BotPicture {
  src: string;
  width: number;
  height: number;
}

export interface BotStreams {
  /** Calls `show` with each new picture until the returned stop. */
  watch(key: BotSurfaceKey, show: (picture: BotPicture) => void): () => void;
  /** Input from the person while they drive; points are in the picture's pixels. */
  input(key: BotSurfaceKey, input: ScreenInput): Promise<void>;
}

export const BotStreamsContext = createContext<BotStreams | undefined>(undefined);

/** The streams this app has, or undefined where the daemon doesn't offer them yet. */
export function useBotStreams(): BotStreams | undefined {
  return use(BotStreamsContext);
}
