// SPDX-License-Identifier: Apache-2.0
/**
 * The native engine's opener (E5.3 step 1). The TypeScript repository's constructors own every
 * open-time statement (the schema setup, the version and column checks, the indexes, and each
 * module's `CREATE … IF NOT EXISTS`), so the native boot builds one `EngineRepository` and drops
 * it, exactly where the TypeScript `Engine` would have built it (`engine/index.ts:172`).
 *
 * `Repo::open` on the Rust side runs no statement and prepares nothing, so this file is the one
 * place open-time SQL exists. A later item whose TypeScript constructor does its own open work
 * (for example `ContextMeters(store, …)`, `index.ts:320`) adds that constructor here, in the
 * TypeScript engine's order, after checking it does no data work at open; if it does, that is a
 * fix on main first.
 *
 * Owner decision 2026-11-24: today's open-time statements are ported as they are, in the same
 * order. The bounded fills ADR 0170 asks for are a later Rust-only item, not this one.
 */
import { EngineRepository } from "../engine/repository.ts";
import type { EngineOptions } from "../engine/engine-options.ts";
import type { Store } from "../store.ts";

/** The engine's slot capacity as the facade passes it (`maxActiveThreads`, 64). */
export const MAX_ACTIVE_THREADS = 64;

/**
 * Run the TypeScript repository's open sequence and drop the object: schema only, the same
 * statements in the same order. A refusal (`IncompatibleDataError` from `requireEngineVersion`
 * or `requireEngineColumns`) is thrown from the native facade's constructor here, where the
 * TypeScript engine throws it.
 */
export function openEngineData(store: Store, options: EngineOptions, now: () => number): void {
  // Constructed for the schema setup only, so the reference is dropped at once.
  const repository = new EngineRepository(
    store,
    options.ids,
    MAX_ACTIVE_THREADS,
    options.commandId,
    options.aceToolAction,
    now,
  );
  void repository;
}
