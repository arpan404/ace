import type { ThreadKey } from "@ace/client";
import { useItemOrder, useThread } from "@ace/client-react";
import { FileTextIcon, ImageIcon, InfoIcon, PlusIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { fileTab } from "@/features/panels/index.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import { sameSources, sourcesOf, type Source } from "./summary-model.ts";

const noSources: readonly Source[] = [];
/** Rows before "View all"; the rest show in place, the card scrolling if they must. */
const firstFew = 3;

/** Why only some sources show: the gap a daemon API would close. */
const partial =
  "Files and images attached to this thread's loaded messages. The daemon doesn't list a thread's whole context yet, so older pages aren't counted.";

/**
 * Sources: what the thread was given to work from (files and images attached to its messages),
 * each opening as a tab. + opens the composer's Add menu, where files, images, file mentions
 * and pages are added to the next message.
 */
export function SummarySources(props: { thread: ThreadRef; onAdd(): void }) {
  const id = props.thread.id;
  const workspace = useWorkspaceActions(id);
  const order = useItemOrder(id);
  const keys = useMemo<ThreadKey[]>(
    () => ["order", ...(order ?? []).map((item): ThreadKey => `item:${item}`)],
    [order],
  );
  const sources = useThread(id, keys, sourcesOf, sameSources) ?? noSources;
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, firstFew);
  return (
    <section aria-label="Sources" className="mt-1">
      <div className="flex h-7 items-center gap-1 pr-0.5 pl-2.5">
        <h3 className="text-xs font-medium text-subtle-foreground">Sources</h3>
        <Tip label={partial}>
          <span
            tabIndex={0}
            aria-label="About sources"
            className="grid size-5 place-items-center rounded-sm text-subtle-foreground outline-none focus-visible:bg-accent"
          >
            <InfoIcon aria-hidden size={12} />
          </span>
        </Tip>
        <IconButton
          icon={PlusIcon}
          label="Add files and context"
          size="sm"
          className="ml-auto size-7"
          onClick={props.onAdd}
        />
      </div>
      {sources.length === 0 ? (
        <p className="flex h-8 items-center px-2.5 text-xs text-subtle-foreground">
          Nothing attached yet
        </p>
      ) : (
        <ul style={{ maxHeight: 220 }} className="flex flex-col overflow-y-auto">
          {shown.map((source) => {
            const path = source.path;
            return (
              <li key={source.key}>
                <SourceRow
                  source={source}
                  onOpen={path ? () => workspace.open(fileTab(path)) : undefined}
                />
              </li>
            );
          })}
        </ul>
      )}
      {sources.length > firstFew && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
          className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
        >
          {all ? "Show fewer" : `View all ${sources.length}`}
        </button>
      )}
    </section>
  );
}

function SourceRow(props: { source: Source; onOpen: (() => void) | undefined }) {
  const Glyph = props.source.kind === "image" ? ImageIcon : FileTextIcon;
  const body = (
    <>
      <Glyph aria-hidden size={16} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{props.source.title}</span>
    </>
  );
  const row = "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-ui";
  if (!props.onOpen)
    return (
      <Tip label="Shown in its message; images don't open as tabs yet">
        <span tabIndex={0} className={`${row} text-muted-foreground outline-none`}>
          {body}
        </span>
      </Tip>
    );
  return (
    <button
      type="button"
      title={props.source.path}
      onClick={props.onOpen}
      className={`${row} text-foreground outline-none hover:bg-accent focus-visible:bg-accent`}
    >
      {body}
    </button>
  );
}
