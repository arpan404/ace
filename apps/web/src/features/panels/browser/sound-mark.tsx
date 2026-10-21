import { SpeakerHighIcon, SpeakerSlashIcon } from "@phosphor-icons/react";
import { useCallback, useSyncExternalStore } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { BrowserTabView, PreviewSource } from "../sources.ts";

/** What a click on the address bar's speaker does. */
export type SoundStep =
  | { kind: "mute-tab" }
  | { kind: "unmute-tab"; hereToo: boolean }
  | { kind: "play-here" };

export interface SoundControl {
  muted: boolean;
  label: string;
  step: SoundStep;
}

/**
 * The speaker at the end of the address bar, as a browser shows it (pure). It shows only while
 * the page plays sound or its tab is muted, and tells what the person hears:
 *
 * - The tab is muted (`browser.tabs.mute`, for everyone): crossed out; a click unmutes it, and
 *   turns sound on on this device too when its video view is off (ADR 0088, Audio).
 * - The page plays, but this device's video view has its sound off: crossed out; a click turns
 *   it on here. Only a click may: phone browsers start sound inside a gesture alone.
 * - Otherwise the person hears it: a click mutes the tab.
 *
 * `here` is this device's choice for a video view; undefined where the page plays natively or
 * this client can't play it.
 */
export function soundControl(
  tab: Pick<BrowserTabView, "audible" | "muted"> | undefined,
  here: boolean | undefined,
): SoundControl | undefined {
  if (tab?.muted)
    return {
      muted: true,
      label: "Unmute tab",
      step: { kind: "unmute-tab", hereToo: here === false },
    };
  if (!tab?.audible) return undefined;
  if (here === false) return { muted: true, label: "Turn on sound", step: { kind: "play-here" } };
  return { muted: false, label: "Mute tab", step: { kind: "mute-tab" } };
}

/** This device's sound choice for the thread's video view, kept current. */
export function useSoundHere(source: PreviewSource | undefined, threadId: string, video: boolean) {
  const subscribe = useCallback(
    (changed: () => void) => source?.subscribe(changed, threadId) ?? (() => {}),
    [source, threadId],
  );
  const read = useCallback(() => source?.audio?.(threadId), [source, threadId]);
  const here = useSyncExternalStore(subscribe, read, read);
  // A page shown natively (no video) plays its sound itself.
  return video ? here : undefined;
}

/** The speaker inside the address bar's end, for the shown tab. */
export function SoundMark(props: {
  tab: BrowserTabView | undefined;
  source: PreviewSource | undefined;
  threadId: string;
  /** The page shows as video, whose sound this device plays only once the person turns it on. */
  video: boolean;
  muteTab(tabId: string, muted: boolean): void;
}) {
  const here = useSoundHere(props.source, props.threadId, props.video);
  const control = soundControl(props.tab, here);
  const tab = props.tab;
  if (!control || !tab) return null;
  const run = () => {
    const step = control.step;
    // Turn the device's sound on first, inside the click, before anything awaits.
    if (step.kind === "play-here" || (step.kind === "unmute-tab" && step.hereToo))
      props.source?.setAudio?.(props.threadId, true);
    if (step.kind === "mute-tab") props.muteTab(tab.tabId, true);
    if (step.kind === "unmute-tab") props.muteTab(tab.tabId, false);
  };
  const Glyph = control.muted ? SpeakerSlashIcon : SpeakerHighIcon;
  return (
    <Tip label={control.label}>
      <button
        type="button"
        aria-label={control.label}
        onClick={run}
        className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground outline-none focus-ring hover:bg-foreground/8 hover:text-foreground"
      >
        <Glyph aria-hidden size={14} />
      </button>
    </Tip>
  );
}
