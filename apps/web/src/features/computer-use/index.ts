/**
 * Computer use: agents operating apps on this Mac in the background. The Settings page and a
 * thread's panel each load their code on first use, so none of it is in the first paint.
 */
/** The thread workspace's Computer use tab view. */
export const loadComputerUsePanel = () => import("./computer-use-panel.tsx");
/** Settings › Computer use's body (Settings frames it). */
export const loadComputerUseSettings = () =>
  import("./computer-use-page.tsx").then((m) => ({ default: m.ComputerUseSettings }));
/** A key or a point over a live picture as input for what it shows (a Spade bot's screen too). */
export { keyInput, pointerGesture, windowPoint, type ShownPicture } from "./live-input.ts";
/** A Spade bot's screen session, live, with the person's input only while they drive. */
export const loadBotScreen = () => import("./bot-screen.tsx");
