/*
 * The settings schemas `daemon-setting.ts` validates with. Every setting's value schema together
 * is a large module graph, so it loads as its own chunk, started as soon as settings are first
 * imported, instead of joining the first paint.
 */
export { SettingsSet, SettingsValues } from "@ace/protocol";
