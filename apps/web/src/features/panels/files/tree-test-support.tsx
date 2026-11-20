import { ClientProvider } from "@ace/client-react";
import { coldStartReplay, FakeDaemon, ScenarioPlayer } from "@ace/fake-daemon";
import type { Mention } from "@ace/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { DaemonConnectionContext } from "@/boot/connection.tsx";
import { fakeConnection } from "@/boot/fake.ts";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { receiveComposerMentions } from "@/lib/composer-insert.ts";
import { LayoutProvider } from "@/lib/layout.tsx";
import { fakeClient } from "@/test/fake-client.ts";
import type { FileOperationDialog } from "./file-operation.ts";
import { FileOperations } from "./file-operations.tsx";
import { FileTree } from "./file-tree.tsx";
import type { RowMark } from "./file-tree-row.tsx";
import { folderFixture } from "./folders-test-support.ts";
import type { OpenHow } from "./tree-commands.ts";
import { threadId } from "./tree-test-queries.ts";

export { bytes, expand, menuPick, row } from "./tree-test-queries.ts";

/*
 * The Files tree on its own, on a real client and the fake daemon's cold-start checkout, without
 * the app, the thread page or the Files tab around it. What the tree hands its tab (a file to
 * open, a dialog to show, a folder to search, a mention for the composer) is recorded here, as
 * the tab would receive it; a dialog it asks for shows as the tab shows it. Its query cache is set up as the app's is. Tests of what the tab then does with them drive the whole app
 * through explorer-test-support.ts.
 */

export interface TreeOutputs {
  /** Each file the tree asked to open, and how, in order. */
  readonly opened: { path: string; how: OpenHow }[];
  /** Each dialog the tree asked its tab to show (the host shows it, as the tab does). */
  readonly operations: FileOperationDialog[];
  /** Each folder the tree asked to search the contents of. */
  readonly searched: string[];
  /** Each hand-off of mentions to the thread's composer. */
  readonly mentions: (readonly Mention[])[];
  /** Each file upload the tree asked for: the names and the folder they go to. */
  readonly uploads: { names: string[]; folder: string }[];
}

/** What the Files tab keeps for its tree, so a remounted tree starts where the last one was. */
interface TreeMemory {
  read(): { current: string | undefined; expanded: readonly string[] | undefined };
  keep(next: { current?: string; expanded?: readonly string[] }): void;
}

function treeMemory(): TreeMemory {
  let kept: ReturnType<TreeMemory["read"]> = { current: undefined, expanded: undefined };
  return {
    read: () => kept,
    keep: (next) => {
      kept = { ...kept, ...next };
    },
  };
}

function TreeHost(props: {
  threadId?: string;
  outputs: TreeOutputs;
  memory: TreeMemory;
  marks: ReadonlyMap<string, RowMark> | undefined;
}) {
  const { outputs, memory } = props;
  const thread = props.threadId ?? threadId;
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(() => memory.read().expanded);
  const [current, setCurrent] = useState(() => memory.read().current);
  const [operation, setOperation] = useState<FileOperationDialog>();
  useEffect(
    () => receiveComposerMentions(thread, (mentions) => outputs.mentions.push(mentions)),
    [outputs, thread],
  );
  return (
    <>
      <FileTree
        threadId={thread}
        current={current}
        onOpen={(path, how) => {
          outputs.opened.push({ path, how });
          memory.keep({ current: path });
          setCurrent(path);
        }}
        onOperation={(asked) => {
          outputs.operations.push(asked);
          setOperation(asked);
        }}
        onUpload={(files, folder) =>
          outputs.uploads.push({ names: files.map((file) => file.name), folder })
        }
        onFindInFolder={(folder) => outputs.searched.push(folder)}
        onDownload={() => {}}
        query={query}
        onQuery={setQuery}
        expanded={expanded}
        onExpanded={(folders) => {
          memory.keep({ expanded: folders });
          setExpanded(folders);
        }}
        marks={props.marks}
      />
      {operation && (
        <FileOperations
          key={JSON.stringify(operation)}
          threadId={thread}
          operation={operation}
          onClose={() => setOperation(undefined)}
          onChanged={() => {}}
        />
      )}
    </>
  );
}

/**
 * Render the cold-start thread's Files tree alone and wait for its first rows. With `beside`,
 * a second thread's tree (its own checkout) renders next to it, as two Files tabs show.
 */
export async function renderTree(
  options: { marks?: ReadonlyMap<string, RowMark>; beside?: string } = {},
) {
  let now = 1_000;
  const daemon = new FakeDaemon({ clock: () => (now += 1) });
  new ScenarioPlayer(daemon, coldStartReplay()).runThrough("turn-2");
  if (options.beside)
    new ScenarioPlayer(daemon, coldStartReplay(options.beside)).runThrough("turn-2");
  const client = fakeClient(daemon);
  const folders = folderFixture(client, threadId);
  if (options.beside) folderFixture(client, options.beside);
  await client.start();
  const outputs: TreeOutputs = {
    opened: [],
    operations: [],
    searched: [],
    mentions: [],
    uploads: [],
  };
  const besideOutputs: TreeOutputs = {
    opened: [],
    operations: [],
    searched: [],
    mentions: [],
    uploads: [],
  };
  const besideMemory = treeMemory();
  const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } });
  const memory = treeMemory();
  const connection = fakeConnection(daemon);
  const host = (key: number) => (
    <DaemonConnectionContext.Provider value={connection}>
      <ClientProvider client={client}>
        <QueryClientProvider client={queries}>
          <LayoutProvider>
            <TooltipProvider>
              <ToastProvider>
                <section data-thread={threadId}>
                  <TreeHost key={key} outputs={outputs} memory={memory} marks={options.marks} />
                </section>
                {options.beside && (
                  <section data-thread={options.beside}>
                    <TreeHost
                      threadId={options.beside}
                      outputs={besideOutputs}
                      memory={besideMemory}
                      marks={undefined}
                    />
                  </section>
                )}
              </ToastProvider>
            </TooltipProvider>
          </LayoutProvider>
        </QueryClientProvider>
      </ClientProvider>
    </DaemonConnectionContext.Provider>
  );
  let mounts = 0;
  const view = render(host(mounts));
  const treeOf = async (thread: string) => {
    const section = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`section[data-thread="${thread}"]`);
      if (!found) throw new Error(`No tree for ${thread}`);
      return found;
    });
    const found = await within(section).findByRole("tree", { name: "Checkout files" });
    await within(found).findByRole("treeitem", { name: "README.md" });
    return found;
  };
  const tree = await treeOf(threadId);
  const beside = options.beside ? await treeOf(options.beside) : undefined;
  return {
    daemon,
    client,
    tree,
    folders,
    outputs,
    /** The second thread's tree, with `beside`. */
    beside,
    /** Mount a fresh tree in its place, as the Files tab does when it opens a file. */
    async remount() {
      view.rerender(host(++mounts));
      return treeOf(threadId);
    },
  };
}
