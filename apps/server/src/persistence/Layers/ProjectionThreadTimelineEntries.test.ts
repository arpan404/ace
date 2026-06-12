import { ThreadId, TurnId } from "@ace/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadTimelineEntryRepositoryLive } from "./ProjectionThreadTimelineEntries.ts";
import { ProjectionThreadTimelineEntryRepository } from "../Services/ProjectionThreadTimelineEntries.ts";

const layer = it.layer(
  ProjectionThreadTimelineEntryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadTimelineEntryRepository", (it) => {
  it.effect("appends new sources and preserves indexes when updating an existing source", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadTimelineEntryRepository;
      const threadId = ThreadId.makeUnsafe("thread-timeline-repo");
      const turnId = TurnId.makeUnsafe("turn-timeline-repo");

      yield* repository.upsertSourceEntry({
        threadId,
        kind: "message",
        sourceId: "message-user",
        turnId,
        sequence: 1,
        createdAt: "2026-04-01T00:00:01.000Z",
        updatedAt: "2026-04-01T00:00:01.000Z",
      });
      yield* repository.upsertSourceEntry({
        threadId,
        kind: "activity",
        sourceId: "activity-tool",
        turnId,
        sequence: 2,
        createdAt: "2026-04-01T00:00:02.000Z",
        updatedAt: "2026-04-01T00:00:02.000Z",
      });
      yield* repository.upsertSourceEntry({
        threadId,
        kind: "message",
        sourceId: "message-user",
        turnId,
        sequence: 99,
        createdAt: "2026-04-01T00:00:09.000Z",
        updatedAt: "2026-04-01T00:00:10.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(
        rows.map((row) => ({
          index: row.timelineIndex,
          kind: row.kind,
          sourceId: row.sourceId,
          sequence: row.sequence,
          updatedAt: row.updatedAt,
        })),
        [
          {
            index: 0,
            kind: "message",
            sourceId: "message-user",
            sequence: 1,
            updatedAt: "2026-04-01T00:00:10.000Z",
          },
          {
            index: 1,
            kind: "activity",
            sourceId: "activity-tool",
            sequence: 2,
            updatedAt: "2026-04-01T00:00:02.000Z",
          },
        ],
      );
    }),
  );

  it.effect("rebuilds a thread from source projection tables with compact indexes", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadTimelineEntryRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-timeline-rebuild");

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          sequence,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-user',
            'thread-timeline-rebuild',
            'turn-timeline-rebuild',
            'user',
            'Run checks',
            0,
            1,
            '2026-04-01T00:00:01.000Z',
            '2026-04-01T00:00:01.000Z'
          ),
          (
            'message-assistant',
            'thread-timeline-rebuild',
            'turn-timeline-rebuild',
            'assistant',
            'Done',
            0,
            3,
            '2026-04-01T00:00:03.000Z',
            '2026-04-01T00:00:03.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-tool',
          'thread-timeline-rebuild',
          'turn-timeline-rebuild',
          'tool',
          'tool.completed',
          'Run command',
          '{}',
          2,
          '2026-04-01T00:00:02.000Z'
        )
      `;

      yield* repository.rebuildThread({ threadId });
      yield* sql`
        DELETE FROM projection_thread_activities
        WHERE activity_id = 'activity-tool'
      `;
      yield* repository.rebuildThread({ threadId });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(
        rows.map((row) => `${row.timelineIndex}:${row.kind}:${row.sourceId}`),
        ["0:message:message-user", "1:message:message-assistant"],
      );
      assert.equal(yield* repository.countByThreadId({ threadId }), 2);
    }),
  );
});
