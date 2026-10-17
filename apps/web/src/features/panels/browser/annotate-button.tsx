import { SelectionIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  annotateUnavailable,
  useAnnotate,
  type AnnotatablePage,
} from "@/features/annotations/index.ts";
import { cn } from "@/lib/cn.ts";
import type { PreviewSource } from "../sources.ts";
import { roundButton } from "./page-toolbar.tsx";

/** What annotate mode does, in its toggle's tooltip while it is on. */
const annotateHint = "Click anywhere to annotate. Hold Space to temporarily use the webpage.";

/**
 * Annotate, a round toggle beside the navigation pill, tinted with the accent while the page
 * is in annotate mode. Off, it says why it can't start (offline, no web page loaded, the
 * browser paused, a daemon without it). Agents keep working while the person annotates.
 */
export function AnnotateButton(props: {
  source: PreviewSource;
  threadId: string;
  online: boolean;
  /** The page this tab shows, loaded; undefined otherwise. */
  page: AnnotatablePage | undefined;
}) {
  const { source, threadId } = props;
  const unavailable = annotateUnavailable({
    driver: source.annotate,
    online: props.online,
    page: props.page,
  });
  const annotate = useAnnotate({
    threadId,
    driver: source.annotate,
    url: props.page?.url,
    unavailable,
  });
  const on = annotate.mode !== "off";
  return (
    <IconButton
      icon={SelectionIcon}
      label="Annotate"
      tip={on ? annotateHint : "Annotate"}
      pressed={on}
      disabled={!on && !!unavailable}
      reason={unavailable}
      className={cn(
        roundButton,
        "aria-pressed:bg-ring/15 aria-pressed:text-ring-text aria-pressed:hover:bg-ring/22",
      )}
      onClick={annotate.toggle}
    />
  );
}
