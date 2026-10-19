import { SpeakerHighIcon, SpeakerSlashIcon } from "@phosphor-icons/react";
import { useCallback, useSyncExternalStore } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import type { PreviewSource, ScreenFrame } from "../sources.ts";
import { roundButton } from "./page-toolbar.tsx";

/**
 * The page's sound on this device (ADR 0088, Audio): muted until the person taps it, on every
 * device, since a phone only starts sound from a tap. Offered while the page shows as video
 * (sound rides the video capture) on a client that can play it.
 */
export function SpeakerButton(props: {
  source: PreviewSource | undefined;
  threadId: string;
  frame: ScreenFrame | undefined;
}) {
  const { source, threadId } = props;
  const subscribe = useCallback(
    (changed: () => void) => source?.subscribe(changed, threadId) ?? (() => {}),
    [source, threadId],
  );
  const read = useCallback(() => source?.audio?.(threadId), [source, threadId]);
  const on = useSyncExternalStore(subscribe, read, read);
  if (on === undefined || (!on && !props.frame?.video)) return null;
  return (
    <IconButton
      icon={on ? SpeakerHighIcon : SpeakerSlashIcon}
      label={on ? "Mute the page" : "Unmute the page"}
      pressed={on}
      className={roundButton}
      onClick={() => source?.setAudio?.(threadId, !on)}
    />
  );
}
