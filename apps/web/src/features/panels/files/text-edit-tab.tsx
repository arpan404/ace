import { FileTextIcon } from "@ace/icons";
import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { CodeEditor } from "@/features/editor";
import {
  TextEditsContext,
  type TabViewProps,
  type TextEditSession,
} from "@/lib/workspace/index.ts";

/*
 * Text the composer holds (a long paste), edited in the side panel: the same editor as a
 * checkout file, with line numbers. There is no Save: every change goes to the composer, which
 * keeps it once typing pauses.
 */

const noEdits = () => () => {};

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
  useEffect(() => {
    let current = true;
    session.file.text().then(
      (original) => current && setText((typed) => typed ?? original),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
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
  return (
    <section aria-label={props.name} className="flex h-full min-h-0 flex-col bg-background">
      <h2 className="sr-only">{props.name}</h2>
      <div className="min-h-0 flex-1">
        <CodeEditor
          text={text}
          path={props.name}
          label={`Editing ${props.name}`}
          focusOnMount
          onTextChange={(next) => {
            session.type(next);
          }}
        />
      </div>
    </section>
  );
}
