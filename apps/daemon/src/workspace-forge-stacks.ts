import { z } from "zod";
import { GitHubForge, ForgeError, ForgeCommandError, repositoryKey } from "@ace/forge";
import {
  ForgeStackOperation,
  ForgeStackExpected,
  type ForgeStackWorkspace,
  type ForgeRepository,
} from "@ace/protocol";
import type { Store } from "./store.ts";
import { isIncompleteStackOperation, reconcileStackMerge } from "./forge-stack-state.ts";
const saved = z.object({
  cwd: z.string(),
  number: z.number().int().positive(),
  operation: ForgeStackOperation,
  expected: ForgeStackExpected,
  dispatched: z.boolean().optional(),
  version: z.number().int().nonnegative().optional(),
});

/** Persist host UUIDs and uncertain local effects independently of thread associations. */
export class WorkspaceForgeStacks {
  readonly #store: Store;
  readonly #now: () => number;
  readonly #active = new Set<string>();
  constructor(store: Store, now: () => number) {
    this.#now = now;
    this.#store = store;
    store.atomic((db) => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS forge_stack_operations (repo TEXT NOT NULL, stack_id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(repo,stack_id))",
      );
      db.exec(
        "CREATE TABLE IF NOT EXISTS forge_stack_operation_layers (repo TEXT NOT NULL, number INTEGER NOT NULL, stack_id TEXT NOT NULL, PRIMARY KEY(repo,number,stack_id))",
      );
      // A pending call without a host UUID cannot be replayed safely after a restart.
      const rows = db.prepare("SELECT repo,stack_id,value FROM forge_stack_operations").all();
      for (const row of rows) {
        const entry = saved.parse(JSON.parse(z.string().parse(row.value)));
        if (entry.operation.state === "pending" && !entry.operation.uuid) {
          entry.version = (entry.version ?? 0) + 1;
          entry.operation = {
            ...entry.operation,
            state: entry.operation.stage === "push" ? "push_partial" : "uncertain",
            message:
              "ace restarted during this operation. Refresh host and local state before recovery. The write will not be repeated.",
          };
          db.prepare("UPDATE forge_stack_operations SET value=? WHERE repo=? AND stack_id=?").run(
            JSON.stringify(entry),
            z.string().parse(row.repo),
            z.string().parse(row.stack_id),
          );
        }
      }
    });
  }
  #get(repository: ForgeRepository, id: string) {
    const row = this.#store.atomic((db) =>
      db
        .prepare("SELECT value FROM forge_stack_operations WHERE repo=? AND stack_id=?")
        .get(repositoryKey(repository), id),
    );
    return row ? saved.parse(JSON.parse(z.string().parse(row.value))) : undefined;
  }
  #find(repository: ForgeRepository, number: number) {
    const row = this.#store.atomic((db) =>
      db
        .prepare(
          "SELECT value FROM forge_stack_operations o JOIN forge_stack_operation_layers l USING(repo,stack_id) WHERE l.repo=? AND l.number=? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(repositoryKey(repository), number),
    );
    return row ? saved.parse(JSON.parse(z.string().parse(row.value))) : undefined;
  }
  #save(repository: ForgeRepository, id: string, entry: z.infer<typeof saved>) {
    const version = (this.#get(repository, id)?.version ?? 0) + 1;
    const value = saved.parse({ ...entry, version });
    this.#store.atomic((db) => {
      const repo = repositoryKey(repository);
      db.prepare(
        "INSERT INTO forge_stack_operations(repo,stack_id,value,updated_at) VALUES (?,?,?,?) ON CONFLICT(repo,stack_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      ).run(repo, id, JSON.stringify(value), this.#now());
      db.prepare("DELETE FROM forge_stack_operation_layers WHERE repo=? AND stack_id=?").run(
        repo,
        id,
      );
      for (const layer of value.expected.layers)
        db.prepare(
          "INSERT INTO forge_stack_operation_layers(repo,number,stack_id) VALUES (?,?,?)",
        ).run(repo, layer.number, id);
    });
  }
  #reconcile(
    repository: ForgeRepository,
    entry: z.infer<typeof saved>,
    operation: ForgeStackOperation,
  ) {
    const updated = this.#store.atomic(
      (db) =>
        db
          .prepare(
            "UPDATE forge_stack_operations SET value=?,updated_at=? WHERE repo=? AND stack_id=? AND value=?",
          )
          .run(
            JSON.stringify(saved.parse({ ...entry, operation, version: (entry.version ?? 0) + 1 })),
            this.#now(),
            repositoryKey(repository),
            entry.expected.id,
            JSON.stringify(entry),
          ).changes,
    );
    // A slow read must not overwrite a newer operation submitted during its host I/O.
    return updated > 0
      ? operation
      : (this.#get(repository, entry.expected.id)?.operation ?? operation);
  }
  async read(
    cwd: string,
    backend: GitHubForge,
    number: number,
    signal: AbortSignal,
  ): Promise<ForgeStackWorkspace> {
    // Capture the receipt version before ANY host I/O. A later receipt cannot be
    // reconciled using this read's older host snapshot.
    const entry = this.#find(backend.repository, number);
    const stack = await backend.prStack(number, signal);
    let operation = entry?.operation ?? this.#find(backend.repository, number)?.operation ?? null;
    let local: ForgeStackWorkspace["local"] = null;
    let localUnavailable: string | null = null;
    try {
      local = await backend.localStack(signal);
    } catch {
      signal.throwIfAborted();
      localUnavailable =
        "Local stack unavailable. Install the gh stack extension and open a matching stack checkout to rebase. Remote stack reads and merges remain available.";
    }

    if (entry && operation?.action === "merge" && operation.state === "pending" && operation.uuid) {
      try {
        operation = await backend.stackMergeResult(entry.number, operation.uuid, signal);
        operation = this.#reconcile(backend.repository, entry, operation);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ForgeError && error.kind === "not_found") {
          operation = {
            ...operation,
            state: "uncertain",
            message:
              "GitHub's merge result expired. Inspect the layer states before another merge.",
          };
          operation = this.#reconcile(backend.repository, entry, operation);
        } else throw error;
      }
    }
    if (!stack && entry && operation?.action === "merge" && operation.state === "uncertain") {
      const position = entry.expected.layers.findIndex((layer) => layer.number === entry.number);
      const scope = position < 0 ? [] : entry.expected.layers.slice(0, position + 1);
      if (scope.length) {
        const states = await backend.states(
          scope.map((layer) => layer.number),
          signal,
        );
        if (scope.every((layer) => states.get(layer.number)?.state === "merged")) {
          operation = {
            action: "merge",
            state: "merged",
            message: "GitHub confirms the earlier merge completed and the native stack changed.",
          };
          operation = this.#reconcile(backend.repository, entry, operation);
        }
      }
    }
    if (!stack)
      return {
        stack: null,
        local,
        localUnavailable:
          operation && isIncompleteStackOperation(operation)
            ? operation.action === "merge"
              ? "GitHub no longer reports this PR in the original stack. Inspect the recorded request on GitHub and refresh before another merge."
              : "GitHub no longer reports this PR in the original stack. Inspect the recorded operation and recover local changes with gh stack before starting another stack action."
            : localUnavailable,
        operation,
      };
    if (entry && operation && operation === entry.operation) {
      const reconciled = reconcileStackMerge(operation, entry.expected, entry.number, stack);
      if (reconciled !== operation)
        operation = this.#reconcile(backend.repository, entry, reconciled);
    }
    if (
      entry &&
      entry.cwd !== cwd &&
      operation &&
      operation.action !== "merge" &&
      isIncompleteStackOperation(operation)
    )
      localUnavailable =
        "This stack has an unfinished rebase in another task checkout. Recover it in the task that started the rebase.";
    if (
      entry &&
      entry.expected.id !== stack.id &&
      operation &&
      isIncompleteStackOperation(operation)
    )
      localUnavailable =
        "This PR moved to a different native stack while an earlier operation remained unfinished. Inspect that operation before starting another stack action.";
    return { stack, local, localUnavailable, operation };
  }
  async change(
    cwd: string,
    backend: GitHubForge,
    number: number,
    expected: ForgeStackExpected,
    action: ForgeStackOperation["action"],
    method: "merge" | "squash" | "rebase",
    signal: AbortSignal,
    allowed: () => boolean,
  ): Promise<ForgeStackOperation> {
    const key = `${repositoryKey(backend.repository)}:${expected.id}`;
    if (this.#active.has(key)) throw new ForgeError("conflict");
    this.#active.add(key);
    let started = false;
    let dispatched = false;
    let stage: "rebase" | "push" | undefined;
    try {
      const current = await this.read(cwd, backend, number, signal);
      const previous =
        this.#get(backend.repository, expected.id) ?? this.#find(backend.repository, number);
      if (previous && isIncompleteStackOperation(previous.operation)) {
        if (
          previous.operation.action === "merge" ||
          previous.expected.id !== expected.id ||
          previous.cwd !== cwd ||
          action === "merge" ||
          action === "rebase"
        )
          throw new ForgeError("conflict");
        if (action === "push" && previous.operation.state !== "push_partial")
          throw new ForgeError("conflict");
      } else if (action === "continue" || action === "abort" || action === "push")
        throw new ForgeError("conflict");
      if (!current.stack || current.stack.id !== expected.id) throw new ForgeError("conflict");
      const begin = (nextStage?: "rebase" | "push") => {
        stage = nextStage;
        if (!allowed()) throw new ForgeError("forbidden");
        this.#save(backend.repository, expected.id, {
          cwd,
          number,
          expected,
          dispatched: false,
          operation: {
            action,
            state: "pending",
            ...(stage ? { stage } : {}),
            message:
              action === "merge"
                ? "GitHub merge request is being submitted."
                : "gh stack is updating local branches. Publication is disabled.",
          },
        });
        started = true;
      };
      const onDispatch = () => {
        dispatched = true;
        const entry = this.#get(backend.repository, expected.id);
        if (entry) this.#save(backend.repository, expected.id, { ...entry, dispatched });
      };
      const operation =
        action === "merge"
          ? await backend.mergeStack(number, expected, method, signal, allowed, begin, onDispatch)
          : await backend.rebaseStack(number, expected, action, signal, allowed, begin, onDispatch);
      this.#save(backend.repository, expected.id, { cwd, number, expected, operation, dispatched });
      return operation;
    } catch (error) {
      if (error instanceof ForgeCommandError) dispatched = error.dispatched;
      if (started)
        this.#save(backend.repository, expected.id, {
          cwd,
          number,
          expected,
          dispatched,
          operation: {
            action,
            state: !dispatched
              ? "failed"
              : stage === "push"
                ? "push_partial"
                : error instanceof ForgeError &&
                    ["forbidden", "not_found", "rate_limit", "unsupported"].includes(error.kind)
                  ? "failed"
                  : "uncertain",
            ...(stage ? { stage } : {}),
            message: !dispatched
              ? "The command did not start. No write was dispatched. Restore the installed gh CLI and refresh before retrying."
              : error instanceof ForgeError &&
                  ["forbidden", "not_found", "rate_limit", "unsupported"].includes(error.kind)
                ? "GitHub refused this request. Refresh account permissions and host state before another action."
                : "The acknowledgement was lost. ace will not repeat the write. Refresh the host and local stack before recovery.",
          },
        });
      throw error;
    } finally {
      this.#active.delete(key);
    }
  }
}
