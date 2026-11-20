import { ClientProvider } from "@ace/client-react";
import { coldStartReplay, FakeDaemon, ScenarioPlayer } from "@ace/fake-daemon";
import type { Mention } from "@ace/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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

/** What the Files tab keeps for its tree, across a remount. */
interface TreeState {
  current: string | undefined;
  expanded: readonly string[] | undefined;
}

function TreeHost(props: { outputs: TreeOutputs; state: TreeState }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(props.state.expanded);
  const [current, setCurrent] = useState(props.state.current);
  const [operation, setOperation] = useState<FileOperationDialog>();
  const { outputs, state } = props;
  useEffect(
    () => receiveComposerMentions(threadId, (mentions) => outputs.mentions.push(mentions)),
    [outputs],
  );
  return (
    <>
      <FileTree
        threadId={threadId}
        current={current}
        onOpen={(path, how) => {
          outputs.opened.push({ path, how });
          state.current = path;
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
          state.expanded = folders;
          setExpanded(folders);
        }}
      />
      {operation && (
        <FileOperations
          key={JSON.stringify(operation)}
          threadId={threadId}
          operation={operation}
          onClose={() => setOperation(undefined)}
          onChanged={() => {}}
        />
      )}
    </>
  );
}

/** Render the cold-start thread's Files tree alone and wait for its first rows. */
export async function renderTree(options: { current?: string } = {}) {
  let now = 1_000;
  const daemon = new FakeDaemon({ clock: () => (now += 1) });
  new ScenarioPlayer(daemon, coldStartReplay()).runThrough("turn-2");
  const client = fakeClient(daemon);
  const folders = folderFixture(client, threadId);
  await client.start();
  const outputs: TreeOutputs = {
    opened: [],
    operations: [],
    searched: [],
    mentions: [],
    uploads: [],
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } });
  const state: TreeState = { current: options.current, expanded: undefined };
  const host = (key: number) => (
    <DaemonConnectionContext.Provider value={fakeConnection(daemon)}>
      <ClientProvider client={client}>
        <QueryClientProvider client={queries}>
          <LayoutProvider>
            <TooltipProvider>
              <ToastProvider>
                <TreeHost key={key} outputs={outputs} state={state} />
              </ToastProvider>
            </TooltipProvider>
          </LayoutProvider>
        </QueryClientProvider>
      </ClientProvider>
    </DaemonConnectionContext.Provider>
  );
  let mounts = 0;
  const view = render(host(mounts));
  const tree = await screen.findByRole("tree", { name: "Checkout files" });
  await within(tree).findByRole("treeitem", { name: "README.md" });
  return {
    daemon,
    client,
    tree,
    folders,
    outputs,
    /** Mount a fresh tree in its place, as the Files tab does when it opens a file. */
    async remount() {
      view.rerender(host(++mounts));
      const next = await screen.findByRole("tree", { name: "Checkout files" });
      await within(next).findByRole("treeitem", { name: "README.md" });
      return next;
    },
  };
}
