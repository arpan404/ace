import { FileTextIcon } from "@phosphor-icons/react";
import { fileLanguage } from "@ace/ui-core";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  TextEditsContext,
  type TabViewProps,
  type TextEditSession,
} from "@/lib/workspace/index.ts";
import { SourceView, sourceGutter } from "./source-view.tsx";

/*
 * Text the composer holds (a long paste), edited in the side panel: the same source view as a
 * checkout file's editor, with line numbers, under a field that takes the typing. There is no
 * Save: every change goes to the composer, which keeps it once typing pauses.
 */

/** Recolour the text only once typing pauses this long. */
const highlightAfter = 400;
const noEdits = () => () => {};
const countLines = (text: string) => {
  let lines = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) lines++;
  return lines;
};

export default function TextEditTab(props: TabViewProps) {
  const edits = useContext(TextEditsContext);
  const id = props.tab.id;
  const subscribe = useCallback(
    (listener: () => void) => (edits ? edits.subscribe(listener) : noEdits()),
    [edits],
  );
  const session = useSyncExternalStore(subscribe, () => edits?.get(id));
  const name = props.tab.title ?? "Text";
  if (!session)
    return (
      <EmptyState
        icon={FileTextIcon}
        title="This edit has ended"
        description="Open the file from the message box to edit it again."
      />
    );
  return <Editor key={id} name={name} session={session} />;
}

function Editor(props: { name: string; session: TextEditSession }) {
  const { session } = props;
  const [text, setText] = useState(() => session.typed());
  const [failed, setFailed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const ready = text !== undefined;
  // Opened from its chip to be edited: the caret goes straight in, at the start.
  useEffect(() => {
    if (ready) field.current?.focus({ preventScroll: true });
  }, [ready]);
  useEffect(() => {
    let live = true;
    session.file.text().then(
      (original) => live && setText((typed) => typed ?? original),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [session]);
  if (failed && text === undefined)
    return (
      <EmptyState
        icon={FileTextIcon}
        title="Couldn't read this text"
        description="Remove the file from the message and paste it again."
      />
    );
  if (text === undefined) return <Skeleton className="m-3 h-40 rounded-md" />;
  const lines = countLines(text);
  return (
    <section aria-label={props.name} className="flex h-full min-h-0 flex-col bg-background">
      <h2 className="sr-only">{props.name}</h2>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="relative grid min-h-full min-w-full">
          <div aria-hidden className="pointer-events-none col-start-1 row-start-1">
            <SourceView
              text={text + (text.endsWith("\n") ? "\n" : "")}
              lang={fileLanguage(props.name)}
              wrap={false}
              label={`Source of ${props.name}`}
              highlightDelay={highlightAfter}
            />
          </div>
          <textarea
            ref={field}
            rows={lines}
            wrap="off"
            aria-label="File contents"
            spellCheck={false}
            value={text}
            onChange={(event) => {
              const next = event.target.value;
              setText(next);
              session.type(next);
            }}
            className="col-start-1 row-start-1 min-h-full w-full resize-none overflow-hidden bg-transparent py-2 pr-6 font-mono text-ui leading-[22px] text-transparent caret-foreground focus-ring-inset"
            style={{ paddingLeft: sourceGutter(lines) }}
          />
        </div>
      </div>
    </section>
  );
}
