import { useSyncExternalStore } from "react";
import { z } from "zod";

/*
 * How replies sound, remembered on this device (ADR 0134, amended): whether replies are spoken,
 * and the voice, for every bot and for each one. System voices are the device's own, so the
 * choice is kept with the device, not in Spade. A bot without its own choice follows the
 * default. Read leniently: a damaged value is the defaults, never an error.
 */

const key = "ace.spade.voice.v1";

const Choice = z.object({
  speakReplies: z.boolean().optional().catch(undefined),
  /** A system voice's `voiceURI`. */
  systemVoice: z.string().max(512).optional().catch(undefined),
  /** The speech model's name for a voice ("alloy"). */
  endpointVoice: z.string().max(64).optional().catch(undefined),
});
export type VoiceChoice = z.infer<typeof Choice>;

const Prefs = z.object({
  defaults: Choice.catch({}),
  bots: z.record(z.string().max(256), Choice).catch({}),
});
export type VoicePrefs = z.infer<typeof Prefs>;

const empty: VoicePrefs = { defaults: {}, bots: {} };

const storage = () => (typeof localStorage === "undefined" ? undefined : localStorage);

let cached: { raw: string | null; prefs: VoicePrefs } | undefined;
const listeners = new Set<() => void>();

function read(): VoicePrefs {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(key) ?? null;
  } catch {
    return empty;
  }
  if (cached?.raw === raw) return cached.prefs;
  let prefs = empty;
  try {
    const parsed = Prefs.safeParse(JSON.parse(raw ?? "null"));
    if (parsed.success) prefs = parsed.data;
  } catch {
    // Not JSON: the defaults.
  }
  cached = { raw, prefs };
  return prefs;
}

function write(next: VoicePrefs) {
  try {
    storage()?.setItem(key, JSON.stringify(next));
  } catch {
    // Storage full or off: the choice lasts until the page closes.
    cached = { raw: JSON.stringify(next), prefs: next };
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const fromOtherTab = (event: StorageEvent) => {
    if (event.key === key) listener();
  };
  window.addEventListener("storage", fromOtherTab);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", fromOtherTab);
  };
}

/** What a bot sounds like: its own choices over the defaults. */
export interface BotVoice {
  speakReplies: boolean;
  systemVoice: string | undefined;
  endpointVoice: string | undefined;
}

export function botVoice(prefs: VoicePrefs, bot: string | undefined): BotVoice {
  const own = (bot && prefs.bots[bot]) || {};
  return {
    speakReplies: own.speakReplies ?? prefs.defaults.speakReplies ?? false,
    systemVoice: own.systemVoice ?? prefs.defaults.systemVoice,
    endpointVoice: own.endpointVoice ?? prefs.defaults.endpointVoice,
  };
}

/** The current preferences, live. */
export function useVoicePrefs(): VoicePrefs {
  return useSyncExternalStore(subscribe, read, () => empty);
}

export function readVoicePrefs(): VoicePrefs {
  return read();
}

/** Change the defaults (`bot` undefined) or one bot's choice; `undefined` fields follow again. */
export function setVoiceChoice(bot: string | undefined, change: VoiceChoice) {
  const prefs = read();
  if (bot === undefined) {
    write({ ...prefs, defaults: { ...prefs.defaults, ...change } });
    return;
  }
  write({ ...prefs, bots: { ...prefs.bots, [bot]: { ...prefs.bots[bot], ...change } } });
}
