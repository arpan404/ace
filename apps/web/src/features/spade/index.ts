/** Spade, ace's assistant (ADR 0121, 0127): its place in the rail, its bots and its settings. */
export { SpadeSidebar } from "./spade-sidebar.tsx";
/** Spade's place in the rail, with its needs-you dot. */
export { SpadeRailPlace } from "./spade-rail-place.tsx";
export { SpadeAgentScreen, SpadeHomeScreen } from "./spade-screens.tsx";
export { SpadeNewGroupScreen } from "./spade-group-new.tsx";
export { SpadeGroupScreen } from "./spade-group-screen.tsx";
/** New bot, a conversation whose first message makes the bot. */
export { NewBotStart } from "./spade-bot-start.tsx";
/** Settings › Spade: General, Models, Web search and Apps, under `/settings/spade`. */
export { SpadeSettingsScreen, type SpadeSettingsPage } from "./spade-settings-screen.tsx";
/** The live pictures of the bots' browsers and screens, as the app supplies them. */
export { BotStreamsContext, type BotStreams } from "./computer/bot-streams.ts";
/** This machine's bots, as Spade lists them (a plugin's review picks which get it). */
export { readAgents } from "./spade-api.ts";
