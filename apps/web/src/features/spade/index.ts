/** Spade, ace's assistant (ADR 0117): its place in the rail, its conversations and its settings. */
export { SpadeSidebar } from "./spade-sidebar.tsx";
export { SpadeConversationScreen, SpadeNewScreen } from "./spade-screens.tsx";
/** Settings › Spade's body (Settings frames it), loaded on first use. */
export const loadSpadeSettings = () =>
  import("./spade-settings.tsx").then((module) => ({ default: module.SpadeSettings }));
