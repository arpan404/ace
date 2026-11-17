import { ClientProvider, useNotifyBatch, useThreadError } from "@ace/client-react";
import { shallowEqual, useThreadField, type ThreadRecord } from "@ace/client-react/thread-field";
import { createContext, use, useCallback, useLayoutEffect, useMemo, useState } from "react";
import { useLayoutServices, type SessionKey } from "@/lib/layout.tsx";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { useWorkCardStore } from "./work-card-store.ts";
import { createWorkCardTrees, type WorkCardTrees } from "./work-card-trees.ts";

/*
 * Which thread tree a screen's Work card follows: the tree's main thread, found by walking up
 * through the threads that delegated this one, here and on paired machines. Each step is its own
 * component that reads only the fields the walk needs, so a parent's tool steps never re-render
 * the screen, and a chain of any depth resolves without a fixed number of hooks.
 */

/** Past this many parents the walk stops and treats the last one as the tree's main thread. */
export const workCardTreeDepth = 32;

const treesKey: SessionKey<WorkCardTrees> = { name: "workCardTrees" };

/** This app's per-tree card memory, shared by every screen (`work-card-trees`). */
export function useWorkCardTrees(): WorkCardTrees {
  const { storage, sessionValue } = useLayoutServices();
  return sessionValue(treesKey, () => createWorkCardTrees(storage));
}

/**
 * Keeps the screen's card store following its tree. Until the walk ends the store follows no
 * tree: the card stays as it is, and a choice made meanwhile is saved to the tree once known.
 * Render it keyed by the thread id, so another thread starts its own walk.
 */
export function WorkCardTreeFollower(props: { threadId: string }) {
  const store = useWorkCardStore();
  const trees = useWorkCardTrees();
  const [tree, setTree] = useState<string>();
  useLayoutEffect(
    () => (tree !== undefined && store ? store.follow(trees.memory(tree)) : undefined),
    [store, trees, tree],
  );
  const report = useCallback(
    (found: Found) => setTree(found.kind === "loading" ? undefined : found.id),
    [],
  );
  return <TreeStep threadId={props.threadId} seen={none} report={report} />;
}

const none: readonly string[] = [];

type Found =
  | { kind: "loading" }
  | { kind: "root"; id: string }
  /** The step's thread is a daemon's hidden host (Spade): the thread below it is the root. */
  | { kind: "host"; id: string };

interface TreeFacts {
  delegatedBy: string | undefined;
  fromHost: string | undefined;
  fromThread: string | undefined;
  host: string | undefined;
}

const treeFacts = (thread: ThreadRecord): TreeFacts => ({
  delegatedBy: thread.delegatedBy,
  fromHost: thread.delegatedFrom?.hostId,
  fromThread: thread.delegatedFrom?.threadId,
  host: thread.host,
});

/**
 * One thread of the walk. It reports the tree's main thread once known: itself when nothing
 * delegated it, its parent's answer otherwise. A parent that can't be read (gone, or on a machine
 * that is offline or unpaired) ends the walk there, named by the id this thread holds for it.
 */
function TreeStep(props: {
  threadId: string;
  seen: readonly string[];
  report(found: Found): void;
}) {
  const { threadId, seen, report } = props;
  const facts = useThreadField(threadId, treeFacts, shallowEqual);
  const failed = useThreadError(threadId) !== undefined;
  const own: Found | undefined =
    facts === undefined
      ? failed
        ? { kind: "root", id: threadId }
        : { kind: "loading" }
      : facts.host !== undefined
        ? { kind: "host", id: threadId }
        : seen.includes(threadId) || seen.length >= workCardTreeDepth
          ? { kind: "root", id: threadId }
          : facts.delegatedBy === undefined && facts.fromThread === undefined
            ? { kind: "root", id: threadId }
            : undefined;
  const ownKind = own?.kind;
  const ownId = own && own.kind !== "loading" ? own.id : undefined;
  useLayoutEffect(() => {
    if (ownKind === "loading") report({ kind: "loading" });
    else if (ownKind !== undefined && ownId !== undefined) report({ kind: ownKind, id: ownId });
  }, [ownKind, ownId, report]);
  // A parent that is Spade's host is no parent: this thread is the tree's main thread.
  const fromParent = useCallback(
    (found: Found) => report(found.kind === "host" ? { kind: "root", id: threadId } : found),
    [report, threadId],
  );
  // The walk so far with this thread added, stable while neither changes. Ids never hold NUL.
  const walked = [...seen, threadId].join("\u0000");
  const chain = useMemo(() => walked.split("\u0000"), [walked]);
  if (own !== undefined || !facts) return null;
  if (facts.delegatedBy !== undefined)
    return <TreeStep threadId={facts.delegatedBy} seen={chain} report={fromParent} />;
  if (facts.fromThread === undefined) return null;
  return (
    <RemoteStep
      host={facts.fromHost}
      threadId={facts.fromThread}
      seen={chain}
      report={fromParent}
    />
  );
}

interface RemoteProps {
  host: string | undefined;
  threadId: string;
  seen: readonly string[];
  report(found: Found): void;
}

/**
 * The machine list, read once by the walk's first step onto a paired machine. Steps below it run
 * against another machine's client, where reading the list would ask that machine for this
 * window's own identity, so they take it from here.
 */
const TreeMachines = createContext<readonly Machine[] | undefined>(undefined);

/**
 * The walk's step onto a parent on a paired machine, read through that machine's client. Only
 * these steps read the machine list, so a local chain never loads it.
 */
function RemoteStep(props: RemoteProps) {
  const known = use(TreeMachines);
  return known ? <RemoteHop {...props} machines={known} /> : <FirstRemoteStep {...props} />;
}

function FirstRemoteStep(props: RemoteProps) {
  const machines = useMachines();
  return (
    <TreeMachines value={machines}>
      <RemoteHop {...props} machines={machines} />
    </TreeMachines>
  );
}

function RemoteHop(props: RemoteProps & { machines: readonly Machine[] }) {
  const { host, threadId, report } = props;
  const machine = props.machines.find((each) => each.id === host);
  const batch = useNotifyBatch();
  const reachable = machine?.client !== undefined;
  useLayoutEffect(() => {
    if (!reachable) report({ kind: "root", id: threadId });
  }, [reachable, report, threadId]);
  if (!machine?.client) return null;
  return (
    <ClientProvider client={machine.client} batch={batch}>
      <TreeStep threadId={threadId} seen={props.seen} report={report} />
    </ClientProvider>
  );
}
