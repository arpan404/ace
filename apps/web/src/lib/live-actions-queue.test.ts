import type { CommandPayload } from "@ace/protocol";
import { configure, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { createQueryClient } from "@/app.tsx";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";
import { changeQueue } from "./live-actions.ts";
import { restoreQueries, restoredUnconfirmedNow } from "./query-persistence.ts";

/*
 * The gated sender owns the check on a queue page kept from an earlier session: a change decided
 * on one is refused as it sends, whatever the screen drew, even with the thread's copy current.
 * Once the daemon has answered a read of that page, the same change goes.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const threadId = "thread-idle";

test("a queue change decided on a kept page the daemon hasn't answered is refused as it sends, and goes once it has", async () => {
  const queries = createQueryClient();
  const app = harness({ queryClient: queries });
  createIdleTask(app.daemon, {
    id: threadId,
    workspaceId: "relay",
    title: "Tidy",
    provider: "codex",
  });
  await app.open(`/t/${threadId}`);
  await screen.findByRole("combobox", { name: "Message" });
  await waitFor(() => expect(app.client.peekThread?.(threadId)?.syncing).toBe(false));

  // A queue page read back from disk, at the key and time it was kept.
  const key = ["queue", threadId, 7];
  restoreQueries(queries, [
    { key, data: { threadId, revision: 7, messages: [], next: null }, at: 1_000 },
  ]);
  const shown = queries.getQueryData(key);
  const copy = { unconfirmedNow: () => restoredUnconfirmedNow(queries, shown) };
  const sent: CommandPayload[] = [];
  const send = (payload: CommandPayload) => {
    sent.push(payload);
    return Promise.resolve();
  };
  const remove = () =>
    changeQueue(
      app.client,
      { threadId, expectedRevision: 7, copy },
      { kind: "remove", messageId: "message-1" },
      send,
    );

  expect(remove()).toEqual({ ok: false, refused: "unconfirmed_queue" });
  expect(sent).toEqual([]);

  // The daemon answers a read of that page: the same copy is now confirmed.
  queries.setQueryData(key, shown, { updatedAt: 2_000 });
  expect(remove().ok).toBe(true);
  expect(sent.map((payload) => payload.type)).toEqual(["queue.remove"]);
});
