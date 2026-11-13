/** Spade, ace's assistant (ADR 0121, 0127): its place in the rail, its bots and its settings. */
export { SpadeSidebar } from "./spade-sidebar.tsx";
/** Spade's place in the rail, with its needs-you dot. */
export { SpadeRailPlace } from "./spade-rail-place.tsx";
export { SpadeAgentScreen, SpadeHomeScreen } from "./spade-screens.tsx";
export { SpadeGroupScreen } from "./spade-group-screen.tsx";
/** Settings › Spade, at `/settings/spade`. */
export { SpadeSettingsScreen } from "./spade-settings-screen.tsx";
/** The live pictures of the bots' browsers and screens, as the app supplies them. */
export { BotStreamsContext, type BotStreams } from "./computer/bot-streams.ts";
