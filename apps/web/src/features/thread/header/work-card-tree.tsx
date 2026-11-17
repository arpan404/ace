import {
  ClientProvider,
  OptionalLeaseScope,
  useClient,
  useConnectionState,
  useNotifyBatch,
  useThreadError,
  useThreadRoom,
} from "@ace/client-react";
import { shallowEqual, useThreadField, type ThreadRecord } from "@ace/client-react/thread-field";
import { createContext, use, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  const [tree, setTree] = useState<{ id: string; fallback: boolean }>();
  /** The fallback tree followed while the real one couldn't be found, and its choice then. */
  const fellBack = useRef<{ id: string; open: boolean }>(undefined);
  useLayoutEffect(() => {
    if (!tree || !store) return;
    const memory = trees.memory(tree.id);
    const held = fellBack.current;
    if (tree.fallback) fellBack.current = { id: tree.id, open: memory.open() };
    else {
      fellBack.current = undefined;
      // A choice made on the fallback tree carries over to the tree it stood in for.
      const open = held && held.id !== tree.id ? trees.memory(held.id).open() : undefined;
      if (held && open !== undefined && open !== held.open) memory.remember(open);
    }
    return store.follow(memory);
  }, [store, trees, tree]);
  const report = useCallback(
    (found: Found) =>
      setTree((was) =>
        found.kind === "loading"
          ? undefined
          : was?.id === found.id && was.fallback === (found.kind === "fallback")
            ? was
            : { id: found.id, fallback: found.kind === "fallback" },
      ),
    [],
  );
  return <TreeStep threadId={props.threadId} seen={none} report={report} />;
}

const none: readonly string[] = [];

type Found =
  | { kind: "loading" }
  | { kind: "root"; id: string }
  /**
   * The walk couldn't go on (the connection lost, a machine unreachable): the last thread it
   * could name stands in until it can. A choice made meanwhile moves to the real tree.
   */
  | { kind: "fallback"; id: string }
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

/** Parent facts already read, at most this many: a parent never changes, so none go stale. */
const factsKept = 1000;
/** Per machine's client: two daemons may hold the same thread id (a restored copy, say). */
const factsKey: SessionKey<WeakMap<object, Map<string, TreeFacts>>> = {
  name: "workCardTreeFacts",
};

/**
 * One thread of the walk. It reports the tree's main thread once known: itself when nothing
 * delegated it, its parent's answer otherwise. A thread that can't be read (gone, no room to
 * subscribe, its machine offline or unpaired) ends the walk there, named by the id held for it;
 * the walk goes on once it can be read.
 */
function TreeStep(props: {
  threadId: string;
  seen: readonly string[];
  report(found: Found): void;
}) {
  const { threadId, seen, report } = props;
  const byClient = useLayoutServices().sessionValue(factsKey, () => new WeakMap());
  const client = useClient();
  const known = useMemo(() => {
    let map = byClient.get(client);
    if (!map) byClient.set(client, (map = new Map()));
    return map;
  }, [byClient, client]);
  const [facts, setFacts] = useState(() => known.get(threadId));
  const [unreadable, setUnreadable] = useState(false);
  const found = useCallback(
    (next: TreeFacts) => {
      known.delete(threadId);
      known.set(threadId, next);
      if (known.size > factsKept) known.delete(known.keys().next().value ?? threadId);
      setFacts(next);
    },
    [known, threadId],
  );
  // Room to subscribe coming back retries a read refused for lack of it.
  const room = useThreadRoom() > 0;
  const own: Found | undefined =
    facts === undefined
      ? unreadable
        ? { kind: "fallback", id: threadId }
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
    (next: Found) => report(next.kind === "host" ? { kind: "root", id: threadId } : next),
    [report, threadId],
  );
  // The walk so far with this thread added, stable while neither changes. Ids never hold NUL.
  const walked = [...seen, threadId].join("\u0000");
  const chain = useMemo(() => walked.split("\u0000"), [walked]);
  if (!facts)
    return (
      <OptionalLeaseScope>
        <ReadFacts
          key={String(room)}
          threadId={threadId}
          found={found}
          unreadable={setUnreadable}
        />
      </OptionalLeaseScope>
    );
  if (own !== undefined) return null;
  if (facts.delegatedBy !== undefined)
    return (
      <TreeStep
        key={facts.delegatedBy}
        threadId={facts.delegatedBy}
        seen={chain}
        report={fromParent}
      />
    );
  if (facts.fromThread === undefined) return null;
  return (
    <RemoteStep
      key={facts.fromThread}
      host={facts.fromHost}
      threadId={facts.fromThread}
      seen={chain}
      report={fromParent}
    />
  );
}

/**
 * Holds the thread only until its facts arrive, and only in spare subscription room (an optional
 * lease), so a long chain never holds many threads nor takes room from one the person opens.
 */
function ReadFacts(props: {
  threadId: string;
  found(facts: TreeFacts): void;
  unreadable(unreadable: boolean): void;
}) {
  const { threadId, found, unreadable } = props;
  const facts = useThreadField(threadId, treeFacts, shallowEqual);
  const failed = useThreadError(threadId) !== undefined;
  // Lost, not merely still connecting: a first connect is not a reason to give up the walk.
  const state = useConnectionState();
  const down = state === "reconnecting" || state === "offline" || state === "fatal";
  useLayoutEffect(() => {
    if (facts) found(facts);
  }, [facts, found]);
  const stuck = !facts && (failed || down);
  useLayoutEffect(() => unreadable(stuck), [stuck, unreadable]);
  return null;
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
    if (!reachable) report({ kind: "fallback", id: threadId });
  }, [reachable, report, threadId]);
  if (!machine?.client) return null;
  return (
    <ClientProvider client={machine.client} batch={batch}>
      <TreeStep threadId={threadId} seen={props.seen} report={report} />
    </ClientProvider>
  );
}
