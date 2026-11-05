import type { ClientApi } from "@ace/client";
import type { Admission, AdmissionResult } from "@ace/protocol";
import { useCallback, useSyncExternalStore } from "react";

/*
 * Whether a machine takes new work ("Pause new work"), as its daemon owns it (`admission.request`).
 * One watch per client: read on every ready connection, kept current by `admission.changed`, so
 * the Paused banner, the Fleet row and the desktop tray all show the same gate.
 */

export type PauseOutcome = { ok: true; admission: Admission } | { ok: false; problem: string };

/** What a pause or resume answer means for the person. */
export function pauseOutcome(reply: AdmissionResult, machine: string): PauseOutcome {
  if (reply.ok && reply.admission) return { ok: true, admission: reply.admission };
  if (reply.error === "forbidden")
    return {
      ok: false,
      problem: `This window can view ${machine} but can't pause it. Pair it with full access.`,
    };
  return { ok: false, problem: `Couldn't reach ${machine}. Try again.` };
}

interface Watch {
  /** Undefined until read, while not connected, and when the daemon predates pausing from a client. */
  value: Admission | undefined;
  listeners: Set<() => void>;
  /** Bumped on every connection change, so an answer from an earlier connection is dropped. */
  connection: number;
}

const watches = new WeakMap<ClientApi, Watch>();
let sequence = 0;

function show(watch: Watch, value: Admission | undefined) {
  watch.value = value;
  for (const listener of watch.listeners) listener();
}

function watchOf(client: ClientApi): Watch {
  const existing = watches.get(client);
  if (existing) return existing;
  const watch: Watch = { value: undefined, listeners: new Set(), connection: 0 };
  watches.set(client, watch);
  const read = () => {
    if (client.state !== "ready") return;
    const asked = watch.connection;
    const answer = (value: Admission | undefined) => {
      if (watch.connection === asked) show(watch, value);
    };
    client
      .request(
        { type: "admission.request", requestId: `admission-${++sequence}`, operation: "status" },
        { timeoutMs: 15_000 },
      )
      .then((reply) => answer(reply.ok ? reply.admission : undefined))
      // An older daemon doesn't know the request: no row and no banner, rather than wrong ones.
      .catch(() => answer(undefined));
  };
  client.onMessage((message) => {
    if (message.type === "admission.changed") show(watch, message.admission);
  });
  const connection = client.connectionState();
  let ready = client.state === "ready";
  connection.subscribe(() => {
    const now = connection.getSnapshot() === "ready";
    if (now === ready) return;
    ready = now;
    watch.connection += 1;
    // A daemon that went away may come back unpaused (or be another one): show nothing until
    // the new connection says.
    if (now) read();
    else if (watch.value) show(watch, undefined);
  });
  read();
  return watch;
}

/** The machine's admission as its daemon reports it; undefined until known. */
export function useAdmission(client: ClientApi | undefined): Admission | undefined {
  const subscribe = useCallback(
    (changed: () => void) => {
      if (!client) return () => {};
      const watch = watchOf(client);
      watch.listeners.add(changed);
      return () => void watch.listeners.delete(changed);
    },
    [client],
  );
  const read = () => (client ? watches.get(client)?.value : undefined);
  return useSyncExternalStore(subscribe, read, read);
}

/** Adds (`paused`) or removes the person's own hold; the answer is shown everywhere at once. */
export async function setPaused(
  client: ClientApi,
  paused: boolean,
  machine: string,
): Promise<PauseOutcome> {
  const watch = watchOf(client);
  const asked = watch.connection;
  let outcome: PauseOutcome;
  try {
    const reply = await client.request(
      {
        type: "admission.request",
        requestId: `admission-${++sequence}`,
        operation: paused ? "pause" : "resume",
      },
      { timeoutMs: 15_000 },
    );
    outcome = pauseOutcome(reply, machine);
  } catch {
    outcome = { ok: false, problem: `Couldn't reach ${machine}. Try again.` };
  }
  if (outcome.ok && watch.connection === asked) show(watch, outcome.admission);
  return outcome;
}
