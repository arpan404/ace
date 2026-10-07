import { PlayIcon, PlusIcon } from "@phosphor-icons/react";
import { useDeferredValue, useState } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useRunningTerminalNames } from "@/features/panels/index.ts";
import { useRunScript, useScripts } from "../lib/use-scripts.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { Script } from "../sources/workspace-source.ts";
import { RowButton, RowNote, rowIcon, SectionHead } from "./work-card-parts.tsx";

/** More scripts than this and the section offers a search field. */
const searchFrom = 4;
const addHint = "Add a script to package.json, a Makefile, justfile or Procfile";

/** Scripts whose name or command has every word of `query`, in their order. */
export function matchScripts(scripts: readonly Script[], query: string): readonly Script[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return scripts;
  return scripts.filter((script) => {
    const text = `${script.name} ${script.command}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * Actions: the project's scripts, run in a terminal tab of the side panel. One already running
 * (in a terminal of yours, or an agent's shell running the same command) says so, and running it
 * shows that terminal instead of starting another. A search narrows a long list.
 */
export function ActionsSection(props: { thread: ThreadRef; onClose(returnFocus: boolean): void }) {
  const query = useScripts(props.thread);
  const { run, agentCommands } = useRunScript(props.thread);
  const terminals = useRunningTerminalNames(props.thread.id);
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const scripts = query.data ?? [];
  const shown = matchScripts(scripts, deferred);
  return (
    <section aria-labelledby="work-card-actions">
      <SectionHead id="work-card-actions" title="Actions">
        <IconButton
          icon={PlusIcon}
          label="Add action"
          size="sm"
          className="size-7"
          disabled
          reason={addHint}
        />
      </SectionHead>
      {scripts.length >= searchFrom && (
        <div className="px-1.5 pb-1">
          <SearchField
            label="Search actions"
            placeholder="Search actions"
            value={search}
            onValueChange={setSearch}
            className="h-7"
            onKeyDown={(event) => {
              // Empty, Escape closes the card as it would anywhere else in it.
              if (event.key === "Escape" && !search) {
                event.preventDefault();
                props.onClose(true);
              }
            }}
          />
        </div>
      )}
      {query.isPending ? (
        <RowNote>Loading the project's scripts</RowNote>
      ) : query.isError ? (
        <RowButton onClick={() => void query.refetch()}>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            Couldn't read this project's scripts
          </span>
          <span className="shrink-0 text-xs">Try again</span>
        </RowButton>
      ) : !scripts.length ? (
        <RowNote>{addHint}</RowNote>
      ) : !shown.length ? (
        <RowNote>No action matches “{deferred}”</RowNote>
      ) : (
        <ul aria-label="Project actions" className="flex max-h-[200px] flex-col overflow-y-auto">
          {shown.map((script) => {
            const running =
              terminals.has(script.name) || agentCommands.includes(script.command.trim());
            return (
              <li key={script.id}>
                <RowButton
                  aria-label={`Run ${script.command}${running ? ", running: shows its terminal" : ""}`}
                  onClick={() => {
                    void run(script);
                    props.onClose(false);
                  }}
                >
                  <PlayIcon aria-hidden size={16} className={rowIcon} />
                  <span className="shrink-0">{script.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-subtle-foreground">
                    {script.command}
                  </span>
                  {running && (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Dot tone="done" />
                      running
                    </span>
                  )}
                </RowButton>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
