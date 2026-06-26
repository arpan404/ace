import { CommandId, EventId, ProjectId, ThreadId } from "@ace/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.makeUnsafe("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("replays only events for the requested thread stream", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const now = new Date().toISOString();
      const threadA = ThreadId.makeUnsafe("thread-stream-a");
      const threadB = ThreadId.makeUnsafe("thread-stream-b");

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-stream-project"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-stream"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-stream-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-stream-project"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-stream"),
          title: "Stream Project",
          workspaceRoot: "/tmp/project-stream",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        type: "thread.reverted",
        eventId: EventId.makeUnsafe("evt-stream-thread-a-1"),
        aggregateKind: "thread",
        aggregateId: threadA,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-stream-thread-a-1"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-stream-thread-a-1"),
        metadata: {},
        payload: {
          threadId: threadA,
          turnCount: 1,
        },
      });
      yield* eventStore.append({
        type: "thread.reverted",
        eventId: EventId.makeUnsafe("evt-stream-thread-b"),
        aggregateKind: "thread",
        aggregateId: threadB,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-stream-thread-b"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-stream-thread-b"),
        metadata: {},
        payload: {
          threadId: threadB,
          turnCount: 1,
        },
      });
      yield* eventStore.append({
        type: "thread.reverted",
        eventId: EventId.makeUnsafe("evt-stream-thread-a-2"),
        aggregateKind: "thread",
        aggregateId: threadA,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-stream-thread-a-2"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-stream-thread-a-2"),
        metadata: {},
        payload: {
          threadId: threadA,
          turnCount: 2,
        },
      });

      const replayed = yield* Stream.runCollect(
        eventStore.readThreadFromSequence(threadA, 1, 10),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));

      assert.deepEqual(
        replayed.map((event) => event.eventId),
        [EventId.makeUnsafe("evt-stream-thread-a-1"), EventId.makeUnsafe("evt-stream-thread-a-2")],
      );
    }),
  );
});
