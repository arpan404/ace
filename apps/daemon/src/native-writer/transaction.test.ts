// SPDX-License-Identifier: Apache-2.0
/**
 * The shell's `open`/`close` split (E5.1). New behaviour: before E5.1 `transaction` was one
 * method, so these cases guard what the split must keep — the off path's error precedence and
 * the history-bypass path's lack of a frame — through the native stack.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Store } from "../store.ts";
import { NativeTransactions, type TransactionHost } from "./transaction.ts";

const enabled =
  process.env.ACE_STORE === "native" &&
  (process.env.ACE_STORE_WRITER ?? "").split(",").includes("transactions");

const home = mkdtempSync(join(tmpdir(), "ace-transactions-"));
const store = enabled ? new Store(join(home, "events.sqlite")) : undefined;

afterAll(async () => {
  await store?.close();
  rmSync(home, { recursive: true, force: true });
});

function host(overrides: Partial<TransactionHost> = {}): TransactionHost {
  return {
    flush() {},
    installingHistory: () => false,
    beginThreads() {},
    discardThreads() {},
    commitThreads() {},
    endThreads() {},
    evictWritten() {},
    topRolledBack() {},
    nestedRolledBack() {},
    wakeWal() {},
    committed() {},
    publish() {},
    usage: () => [],
    onError() {},
    ...overrides,
  };
}

function shell(overrides: Partial<TransactionHost> = {}): NativeTransactions {
  const db = store?.nativeTransactionShell?.db;
  if (!db) throw new Error("the transaction shell needs ACE_STORE=native and transactions");
  return new NativeTransactions({ db, host: host(overrides) });
}

describe.runIf(enabled)("the transaction shell's split", () => {
  test("a body's throw and a rollback's throw keep the off path's precedence", () => {
    const transactions = shell({
      topRolledBack() {
        throw new Error("rollback failed");
      },
    });
    // The TypeScript's `finishTop` runs before the caller's error is rethrown, so the rollback
    // error is the one that escapes.
    expect(() =>
      transactions.transaction(() => {
        throw new Error("body failed");
      }),
    ).toThrow("rollback failed");
  });

  test("a history-bypass transaction opens no frame and leaves no context", () => {
    let installing = true;
    const transactions = shell({ installingHistory: () => installing });
    const value = transactions.transaction(() => {
      expect(transactions.transactionOpen).toBe(false);
      return 7;
    });
    expect(value).toBe(7);
    expect(transactions.transactionOpen).toBe(false);
    // The next transaction is a real top-level one, not a leaked bypass frame.
    installing = false;
    const inside = transactions.transaction(() => transactions.transactionOpen);
    expect(inside).toBe(true);
  });
});
