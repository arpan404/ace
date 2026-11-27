// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `reads.json`, the wire messages T3's Rust `readCore` answers, as the protocol's own
 * schema builds them.
 *
 *   bun native/daemon/crates/ace-fanout/vectors/make-read-vectors.ts
 *
 * `CoreClientMessage.parse` is the client's message schema (`packages/protocol/src/wire-core.ts`),
 * so every field name and value is the one the daemon receives. A read that invents a field (the
 * `command.status` bug this guards) is answered from a message no client sends and cannot pass.
 */

import { join } from "node:path";
import { CoreClientMessage } from "@ace/protocol";
import { writeVectors } from "./vectors-io.ts";

const message = (value: unknown) => CoreClientMessage.parse(value);

writeVectors(join(import.meta.dir, "reads.json"), {
  messages: {
    threadsPage: message({
      type: "threads.page",
      requestId: "page-1",
      subscriptionId: "s1",
      before: { at: 7, id: "t_tree" },
    }),
    commandStatus: message({
      type: "command.status",
      requestId: "status-1",
      commandIds: ["c1", "c2", "c3"],
    }),
    unsubscribe: message({ type: "unsubscribe", subscriptionId: "s1" }),
    subscribeThread: message({
      type: "subscribe",
      subscriptionId: "s1",
      scope: { kind: "thread", threadId: "t_tree" },
      paced: true,
      afterSeq: 5,
      tail: { items: 10, bytes: 4096 },
    }),
    subscribeWindow: message({
      type: "subscribe",
      subscriptionId: "s2",
      scope: {
        kind: "threads",
        window: {
          limit: 20,
          project: "w_one",
          archived: false,
          resume: { epoch: "token:activity:0", revision: 3 },
        },
      },
    }),
    outputRead: message({
      type: "output.read",
      requestId: "output-1",
      streamId: "stream-1",
      offset: 0,
      limit: 32768,
    }),
    interactionRead: message({
      type: "interaction.read",
      requestId: "interaction-1",
      threadId: "t_tree",
      interactionId: "i1",
      offset: 0,
    }),
    itemsPage: message({
      type: "items.page",
      requestId: "items-1",
      threadId: "t_tree",
      before: 6,
      limit: 50,
    }),
    entitiesPage: message({
      type: "entities.page",
      requestId: "entities-1",
      threadId: "t_tree",
      collection: "interactions",
      before: 6,
      limit: 10,
      maxBytes: 16384,
    }),
  },
});
