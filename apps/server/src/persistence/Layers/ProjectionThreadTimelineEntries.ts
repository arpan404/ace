import { NonNegativeInt } from "@ace/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadTimelineSourceInput,
  ListProjectionThreadTimelinePageInput,
  ProjectionThreadTimelineEntry,
  ProjectionThreadTimelineEntryRepository,
  type ProjectionThreadTimelineEntryRepositoryShape,
  ThreadTimelineThreadInput,
  UpsertProjectionThreadTimelineEntryInput,
} from "../Services/ProjectionThreadTimelineEntries.ts";

const ProjectionThreadTimelineEntryDbRowSchema = ProjectionThreadTimelineEntry.mapFields(
  Struct.assign({
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

const CountRowSchema = Schema.Struct({
  count: Schema.Number,
});

function toProjectionThreadTimelineEntry(
  row: Schema.Schema.Type<typeof ProjectionThreadTimelineEntryDbRowSchema>,
): ProjectionThreadTimelineEntry {
  return {
    threadId: row.threadId,
    timelineIndex: row.timelineIndex,
    kind: row.kind,
    sourceId: row.sourceId,
    turnId: row.turnId,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const makeProjectionThreadTimelineEntryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadTimelineSourceEntry = SqlSchema.void({
    Request: UpsertProjectionThreadTimelineEntryInput,
    execute: (row) => sql`
      INSERT INTO projection_thread_timeline_entries (
        thread_id,
        timeline_index,
        kind,
        source_id,
        turn_id,
        sequence,
        created_at,
        updated_at
      )
      VALUES (
        ${row.threadId},
        COALESCE(
          (
            SELECT timeline_index
            FROM projection_thread_timeline_entries
            WHERE thread_id = ${row.threadId}
              AND kind = ${row.kind}
              AND source_id = ${row.sourceId}
          ),
          (
            SELECT COALESCE(MAX(timeline_index), -1) + 1
            FROM projection_thread_timeline_entries
            WHERE thread_id = ${row.threadId}
          )
        ),
        ${row.kind},
        ${row.sourceId},
        ${row.turnId},
        ${row.sequence ?? null},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (thread_id, kind, source_id)
      DO UPDATE SET
        turn_id = excluded.turn_id,
        sequence = COALESCE(projection_thread_timeline_entries.sequence, excluded.sequence),
        created_at = projection_thread_timeline_entries.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const deleteProjectionThreadTimelineRows = SqlSchema.void({
    Request: ThreadTimelineThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_timeline_entries
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteProjectionThreadTimelineSourceRow = SqlSchema.void({
    Request: DeleteProjectionThreadTimelineSourceInput,
    execute: ({ threadId, kind, sourceId }) => sql`
      DELETE FROM projection_thread_timeline_entries
      WHERE thread_id = ${threadId}
        AND kind = ${kind}
        AND source_id = ${sourceId}
    `,
  });

  const rebuildProjectionThreadTimelineRows = SqlSchema.void({
    Request: ThreadTimelineThreadInput,
    execute: ({ threadId }) => sql`
      WITH source_entries AS (
        SELECT
          thread_id,
          'message' AS kind,
          message_id AS source_id,
          turn_id,
          sequence,
          created_at,
          updated_at,
          CASE
            WHEN role = 'user' THEN 0
            WHEN role = 'assistant' THEN 2
            ELSE 1
          END AS sort_priority
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        UNION ALL
        SELECT
          thread_id,
          'activity' AS kind,
          activity_id AS source_id,
          turn_id,
          sequence,
          created_at,
          created_at AS updated_at,
          1 AS sort_priority
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        UNION ALL
        SELECT
          thread_id,
          'proposed-plan' AS kind,
          plan_id AS source_id,
          turn_id,
          NULL AS sequence,
          created_at,
          updated_at,
          1 AS sort_priority
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
      ),
      indexed_entries AS (
        SELECT
          thread_id,
          kind,
          source_id,
          turn_id,
          sequence,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY
              created_at ASC,
              CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC,
              sequence ASC,
              sort_priority ASC,
              source_id ASC
          ) - 1 AS timeline_index
        FROM source_entries
      )
      INSERT INTO projection_thread_timeline_entries (
        thread_id,
        timeline_index,
        kind,
        source_id,
        turn_id,
        sequence,
        created_at,
        updated_at
      )
      SELECT
        thread_id,
        timeline_index,
        kind,
        source_id,
        turn_id,
        sequence,
        created_at,
        updated_at
      FROM indexed_entries
    `,
  });

  const countProjectionThreadTimelineRows = SqlSchema.findOne({
    Request: ThreadTimelineThreadInput,
    Result: CountRowSchema,
    execute: ({ threadId }) => sql`
      SELECT COUNT(*) AS count
      FROM projection_thread_timeline_entries
      WHERE thread_id = ${threadId}
    `,
  });

  const listProjectionThreadTimelineRows = SqlSchema.findAll({
    Request: ListProjectionThreadTimelinePageInput,
    Result: ProjectionThreadTimelineEntryDbRowSchema,
    execute: ({ threadId, startIndex, limit }) => sql`
      SELECT
        thread_id AS "threadId",
        timeline_index AS "timelineIndex",
        kind,
        source_id AS "sourceId",
        turn_id AS "turnId",
        sequence,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_timeline_entries
      WHERE thread_id = ${threadId}
        AND timeline_index >= ${startIndex}
        AND timeline_index < ${startIndex + limit}
      ORDER BY timeline_index ASC
    `,
  });

  const upsertSourceEntry: ProjectionThreadTimelineEntryRepositoryShape["upsertSourceEntry"] = (
    input,
  ) =>
    upsertProjectionThreadTimelineSourceEntry(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTimelineEntryRepository.upsertSourceEntry:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadTimelineEntryRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadTimelineRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTimelineEntryRepository.deleteByThreadId:query"),
      ),
    );

  const deleteBySource: ProjectionThreadTimelineEntryRepositoryShape["deleteBySource"] = (input) =>
    deleteProjectionThreadTimelineSourceRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTimelineEntryRepository.deleteBySource:query"),
      ),
    );

  const rebuildThread: ProjectionThreadTimelineEntryRepositoryShape["rebuildThread"] = (input) =>
    deleteProjectionThreadTimelineRows(input).pipe(
      Effect.flatMap(() => rebuildProjectionThreadTimelineRows(input)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTimelineEntryRepository.rebuildThread:query"),
      ),
    );

  const countByThreadId: ProjectionThreadTimelineEntryRepositoryShape["countByThreadId"] = (
    input,
  ) =>
    countProjectionThreadTimelineRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTimelineEntryRepository.countByThreadId:query"),
      ),
      Effect.map((row) => row.count),
    );

  const listPage: ProjectionThreadTimelineEntryRepositoryShape["listPage"] = (input) =>
    listProjectionThreadTimelineRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTimelineEntryRepository.listPage:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadTimelineEntry)),
    );

  return {
    upsertSourceEntry,
    deleteByThreadId,
    deleteBySource,
    rebuildThread,
    countByThreadId,
    listPage,
  } satisfies ProjectionThreadTimelineEntryRepositoryShape;
});

export const ProjectionThreadTimelineEntryRepositoryLive = Layer.effect(
  ProjectionThreadTimelineEntryRepository,
  makeProjectionThreadTimelineEntryRepository,
);
