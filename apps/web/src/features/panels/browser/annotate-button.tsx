import { CursorClickIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  annotateUnavailable,
  useAnnotate,
  type AnnotatablePage,
} from "@/features/annotations/index.ts";
import type { PreviewSource } from "../sources.ts";
import { toolbarButton } from "./page-toolbar.tsx";

/**
 * Annotate, after Reload: pressed while the page is in annotate mode. Off, it says why it
 * can't start (offline, no web page loaded, the browser paused, a daemon without it).
 */
export function AnnotateButton(props: {
  source: PreviewSource;
  threadId: string;
  online: boolean;
  /** The page this tab shows, bound and loaded; undefined otherwise. */
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
    temporaryControl: (id) => source.temporaryControl(id),
    url: props.page?.url,
    unavailable,
  });
  const on = annotate.mode !== "off";
  return (
    <IconButton
      icon={CursorClickIcon}
      label="Annotate"
      pressed={on}
      disabled={!on && !!unavailable}
      reason={unavailable}
      className={toolbarButton}
      onClick={annotate.toggle}
    />
  );
}
