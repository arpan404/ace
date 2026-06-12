import { CheckpointRef, EventId, MessageId, ProjectId, ThreadId, TurnId } from "@ace/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);

const rebuildTimelineEntriesForThread = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    yield* sql`
      DELETE FROM projection_thread_timeline_entries
      WHERE thread_id = ${threadId}
    `;
    yield* sql`
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
    `;
  });

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("loads metadata snapshots from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          queued_composer_messages_json,
          queued_steer_request_json,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          '[{"id":"queued-message-1","prompt":"Follow up later","images":[{"type":"image","id":"queued-image-1","name":"diagram.png","mimeType":"image/png","sizeBytes":12,"dataUrl":"data:image/png;base64,AA=="}],"terminalContexts":[],"modelSelection":{"provider":"codex","model":"gpt-5-codex"},"runtimeMode":"full-access","interactionMode":"default"}]',
          '{"messageId":"queued-message-1","baselineWorkLogEntryCount":2,"interruptRequested":false}',
          'turn-1',
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
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
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          archivedAt: null,
          deletedAt: null,
          icon: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          queuedComposerMessages: [
            {
              id: asMessageId("queued-message-1"),
              prompt: "Follow up later",
              images: [
                {
                  type: "image",
                  id: "queued-image-1" as never,
                  name: "diagram.png",
                  mimeType: "image/png",
                  sizeBytes: 12,
                  dataUrl: "data:image/png;base64,AA==",
                },
              ],
              terminalContexts: [],
              modelSelection: {
                provider: "codex",
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          ],
          queuedSteerRequest: {
            messageId: asMessageId("queued-message-1"),
            baselineWorkLogEntryCount: 2,
            interruptRequested: false,
          },
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.makeUnsafe("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          latestProposedPlanSummary: {
            id: "plan-1",
            turnId: asTurnId("turn-1"),
            implementedAt: "2026-02-24T00:00:05.500Z",
            implementationThreadId: ThreadId.makeUnsafe("thread-2"),
            createdAt: "2026-02-24T00:00:05.000Z",
            updatedAt: "2026-02-24T00:00:05.500Z",
          },
          activities: [],
          checkpoints: [],
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "running",
            providerName: "codex",
            capabilities: {
              sessionModelSwitch: "in-session",
              sessionModelOptionsSwitch: "in-session",
              liveTurnDiffMode: "native",
              reviewChangesMode: "provider",
              reviewSurface: "turn-native",
              approvalRequestsMode: "native",
              turnSteeringMode: "native",
              transcriptAuthority: "provider",
              historyAuthority: "provider-session",
              sessionResumeMode: "native",
              sessionForkMode: "native",
            },
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            commands: [],
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);
    }),
  );

  it.effect(
    "reconciles stale running sessions from provider runtime rows in snapshots and targeted thread reads",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("thread-stale-runtime");
        const turnId = asTurnId("turn-stale-runtime");
        const stoppedAt = "2026-04-06T10:05:00.000Z";

        yield* sql`DELETE FROM provider_session_runtime`;
        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_proposed_plans`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_state`;

        yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            default_model_selection_json,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'project-stale-runtime',
            'Runtime reconciliation',
            '/tmp/project-stale-runtime',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-06T09:58:00.000Z',
            '2026-04-06T09:58:00.000Z',
            NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            branch,
            worktree_path,
            queued_composer_messages_json,
            queued_steer_request_json,
            latest_turn_id,
            created_at,
            updated_at,
            archived_at,
            deleted_at
          )
          VALUES (
            ${threadId},
            'project-stale-runtime',
            'Stale runtime thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            '[]',
            NULL,
            ${turnId},
            '2026-04-06T09:59:00.000Z',
            '2026-04-06T10:00:00.000Z',
            NULL,
            NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            provider_name,
            provider_session_id,
            provider_thread_id,
            runtime_mode,
            active_turn_id,
            last_error,
            updated_at
          )
          VALUES (
            ${threadId},
            'running',
            'codex',
            'provider-session-stale-runtime',
            'provider-thread-stale-runtime',
            'full-access',
            ${turnId},
            NULL,
            '2026-04-06T10:00:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            pending_message_id,
            source_proposed_plan_thread_id,
            source_proposed_plan_id,
            assistant_message_id,
            state,
            requested_at,
            started_at,
            completed_at,
            checkpoint_turn_count,
            checkpoint_ref,
            checkpoint_status,
            checkpoint_files_json
          )
          VALUES (
            ${threadId},
            ${turnId},
            NULL,
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-06T09:59:30.000Z',
            '2026-04-06T10:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
        `;
        yield* sql`
          INSERT INTO provider_session_runtime (
            thread_id,
            provider_name,
            adapter_key,
            runtime_mode,
            status,
            last_seen_at,
            resume_cursor_json,
            runtime_payload_json
          )
          VALUES (
            ${threadId},
            'codex',
            'codex',
            'full-access',
            'stopped',
            ${stoppedAt},
            NULL,
            '{"activeTurnId":null,"lastRuntimeEvent":"provider.stopAll","lastRuntimeEventAt":"2026-04-06T10:05:00.000Z"}'
          )
        `;

        let sequence = 1;
        for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
          yield* sql`
            INSERT INTO projection_state (
              projector,
              last_applied_sequence,
              updated_at
            )
            VALUES (
              ${projector},
              ${sequence},
              ${stoppedAt}
            )
          `;
          sequence += 1;
        }

        const snapshot = yield* snapshotQuery.getSnapshot();
        const snapshotThread = snapshot.threads.find((thread) => thread.id === threadId);
        const targetedThreadOption = yield* snapshotQuery.getThread(threadId);
        const targetedThread = Option.getOrUndefined(targetedThreadOption);

        assert.equal(snapshotThread?.session?.status, "stopped");
        assert.equal(snapshotThread?.session?.activeTurnId, null);
        assert.equal(snapshotThread?.session?.updatedAt, stoppedAt);
        assert.equal(snapshotThread?.latestTurn?.state, "interrupted");
        assert.equal(snapshotThread?.latestTurn?.completedAt, stoppedAt);

        assert.equal(targetedThread?.session?.status, "stopped");
        assert.equal(targetedThread?.session?.activeTurnId, null);
        assert.equal(targetedThread?.session?.updatedAt, stoppedAt);
        assert.equal(targetedThread?.latestTurn?.state, "interrupted");
        assert.equal(targetedThread?.latestTurn?.completedAt, stoppedAt);
      }),
  );

  it.effect("returns one metadata snapshot shape and keeps getThread presentation-only", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            default_model_selection_json,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'project-1',
            'Project 1',
            '/tmp/project-1',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-03T00:00:00.000Z',
            '2026-03-03T00:00:00.000Z',
            NULL
          )
        `;

      yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            branch,
            worktree_path,
            queued_composer_messages_json,
            queued_steer_request_json,
            latest_turn_id,
            created_at,
            updated_at,
            archived_at,
            deleted_at
          )
          VALUES
            (
              'thread-1',
              'project-1',
              'Thread 1',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              NULL,
              NULL,
              '[]',
              NULL,
              'turn-1',
              '2026-03-03T00:00:01.000Z',
              '2026-03-03T00:00:01.000Z',
              NULL,
              NULL
            ),
            (
              'thread-2',
              'project-1',
              'Thread 2',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'plan',
              NULL,
              NULL,
              '[]',
              NULL,
              NULL,
              '2026-03-03T00:00:02.000Z',
              '2026-03-03T00:00:02.000Z',
              NULL,
              NULL
            )
        `;

      yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            is_streaming,
            created_at,
            updated_at,
            attachments_json
          )
          VALUES
            (
              'thread-1-user-earlier',
              'thread-1',
              NULL,
              'user',
              'Earlier prompt',
              0,
              '2026-03-03T00:00:02.500Z',
              '2026-03-03T00:00:02.500Z',
              NULL
            ),
            (
              'thread-1-user',
              'thread-1',
              NULL,
              'user',
              'User prompt',
              0,
              '2026-03-03T00:00:03.000Z',
              '2026-03-03T00:00:03.000Z',
              NULL
            ),
            (
              'thread-1-assistant',
              'thread-1',
              'turn-1',
              'assistant',
              'Assistant answer',
              0,
              '2026-03-03T00:00:04.000Z',
              '2026-03-03T00:00:04.000Z',
              NULL
            ),
            (
              'thread-2-user',
              'thread-2',
              NULL,
              'user',
              'Follow-up request',
              0,
              '2026-03-03T00:00:05.000Z',
              '2026-03-03T00:00:05.000Z',
              NULL
            )
        `;

      const largeActivityPayload = { blob: "x".repeat(20_000) };
      const largeActivityPayloadJson = JSON.stringify(largeActivityPayload);

      yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            created_at,
            sequence
          )
          VALUES
            (
              'thread-1-approval',
              'thread-1',
              'turn-1',
              'approval',
              'approval.requested',
              'Command approval requested',
              '{"requestId":"approval-1","requestKind":"command"}',
              '2026-03-03T00:00:06.000Z',
              1
            ),
            (
              'thread-1-runtime-note',
              'thread-1',
              'turn-1',
              'info',
              'runtime.note',
              'Provider running',
              ${largeActivityPayloadJson},
              '2026-03-03T00:00:07.000Z',
              2
            ),
            (
              'thread-2-user-input',
              'thread-2',
              NULL,
              'approval',
              'user-input.requested',
              'Need an answer',
              '{"requestId":"user-input-1","questions":[{"id":"q1","header":"Question","question":"Ready?","options":[]}]}',
              '2026-03-03T00:00:08.000Z',
              1
            )
        `;

      yield* sql`
          INSERT INTO projection_thread_proposed_plans (
            plan_id,
            thread_id,
            turn_id,
            plan_markdown,
            implemented_at,
            implementation_thread_id,
            created_at,
            updated_at
          )
          VALUES (
            'plan-1',
            'thread-2',
            NULL,
            '# Suggested plan',
            NULL,
            NULL,
            '2026-03-03T00:00:09.000Z',
            '2026-03-03T00:00:09.000Z'
          )
        `;

      yield* sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            pending_message_id,
            assistant_message_id,
            state,
            requested_at,
            started_at,
            completed_at,
            checkpoint_turn_count,
            checkpoint_ref,
            checkpoint_status,
            checkpoint_files_json
          )
          VALUES (
            'thread-1',
            'turn-0',
            NULL,
            NULL,
            'completed',
            '2026-03-03T00:00:09.000Z',
            '2026-03-03T00:00:09.000Z',
            '2026-03-03T00:00:09.500Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-1',
            NULL,
            'thread-1-assistant',
            'completed',
            '2026-03-03T00:00:10.000Z',
            '2026-03-03T00:00:10.000Z',
            '2026-03-03T00:00:11.000Z',
            1,
            'checkpoint-1',
            'ready',
            '[{"path":"README.md","kind":"modified","additions":1,"deletions":0}]'
          )
        `;

      let sequence = 11;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
            INSERT INTO projection_state (
              projector,
              last_applied_sequence,
              updated_at
            )
            VALUES (
              ${projector},
              ${sequence},
              '2026-03-03T00:00:12.000Z'
            )
          `;
        sequence += 1;
      }

      const metadataSnapshot = yield* snapshotQuery.getSnapshot({ hydrateThreadId: null });
      const metadataThread1 = metadataSnapshot.threads.find(
        (thread) => thread.id === ThreadId.makeUnsafe("thread-1"),
      );
      const metadataThread2 = metadataSnapshot.threads.find(
        (thread) => thread.id === ThreadId.makeUnsafe("thread-2"),
      );

      assert.equal(metadataThread1 !== undefined, true);
      assert.equal(metadataThread2 !== undefined, true);
      assert.deepEqual(metadataThread1?.messages, []);
      assert.equal(metadataThread1?.latestTurn?.turnId, asTurnId("turn-1"));
      assert.deepEqual(metadataThread1?.activities, []);
      assert.deepEqual(metadataThread1?.checkpoints, []);
      assert.deepEqual(metadataThread1?.proposedPlans, []);
      assert.deepEqual(metadataThread2?.messages, []);
      assert.deepEqual(metadataThread2?.activities, []);
      assert.deepEqual(metadataThread2?.checkpoints, []);
      assert.deepEqual(metadataThread2?.proposedPlans, []);
      assert.deepEqual(metadataThread2?.latestProposedPlanSummary, {
        id: "plan-1",
        turnId: null,
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-03-03T00:00:09.000Z",
        updatedAt: "2026-03-03T00:00:09.000Z",
      });

      yield* rebuildTimelineEntriesForThread(sql, "thread-1");
      yield* rebuildTimelineEntriesForThread(sql, "thread-2");

      const targetedSnapshot = yield* snapshotQuery.getSnapshot({
        hydrateThreadId: ThreadId.makeUnsafe("thread-1"),
      });
      const targetedSnapshotThread1 = targetedSnapshot.threads.find(
        (thread) => thread.id === ThreadId.makeUnsafe("thread-1"),
      );
      const targetedSnapshotThread2 = targetedSnapshot.threads.find(
        (thread) => thread.id === ThreadId.makeUnsafe("thread-2"),
      );

      assert.deepEqual(targetedSnapshotThread1?.messages, []);
      assert.equal(targetedSnapshotThread1?.latestTurn?.turnId, asTurnId("turn-1"));
      assert.deepEqual(targetedSnapshotThread1?.activities, []);
      assert.deepEqual(targetedSnapshotThread1?.checkpoints, []);
      assert.deepEqual(targetedSnapshotThread1?.proposedPlans, []);
      assert.deepEqual(targetedSnapshotThread2?.messages, []);
      assert.deepEqual(targetedSnapshotThread2?.activities, []);
      assert.deepEqual(targetedSnapshotThread2?.checkpoints, []);
      assert.deepEqual(targetedSnapshotThread2?.proposedPlans, []);
      assert.equal(targetedSnapshotThread2?.latestProposedPlanSummary?.id, "plan-1");

      const targetedThread = yield* snapshotQuery.getThread(ThreadId.makeUnsafe("thread-1"));
      const missingThread = yield* snapshotQuery.getThread(ThreadId.makeUnsafe("thread-missing"));

      assert.equal(Option.isSome(targetedThread), true);
      assert.equal(Option.isNone(missingThread), true);
      assert.deepEqual(
        targetedThread.pipe(
          Option.match({
            onNone: () => [],
            onSome: (thread) => thread.messages.map((message) => message.id),
          }),
        ),
        [
          asMessageId("thread-1-user-earlier"),
          asMessageId("thread-1-user"),
          asMessageId("thread-1-assistant"),
        ],
      );
      assert.deepEqual(
        targetedThread.pipe(
          Option.match({
            onNone: () => [],
            onSome: (thread) => thread.activities.map((activity) => activity.id),
          }),
        ),
        ["thread-1-approval", "thread-1-runtime-note"],
      );
      assert.equal(
        targetedThread.pipe(
          Option.match({
            onNone: () => 0,
            onSome: (thread) => thread.checkpoints.length,
          }),
        ),
        1,
      );
    }),
  );

  it.effect("keeps stored backend activities out of UI-serving thread hydration", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-activity-cap");
      const totalActivityCount = 2_005;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_timeline_entries`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-activity-cap',
          'Activity Cap Project',
          '/tmp/activity-cap',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-03-04T00:00:00.000Z',
          '2026-03-04T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          queued_composer_messages_json,
          queued_steer_request_json,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          ${threadId},
          'project-activity-cap',
          'Thread Activity Cap',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          '[]',
          NULL,
          NULL,
          '2026-03-04T00:00:01.000Z',
          '2026-03-04T00:00:01.000Z',
          NULL,
          NULL
        )
      `;

      yield* Effect.forEach(
        Array.from({ length: totalActivityCount }, (_, index) => index + 1),
        (sequence) =>
          sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              created_at,
              sequence
            )
            VALUES (
              ${`activity-${sequence}`},
              ${threadId},
              NULL,
              'info',
              'runtime.note',
              ${`Activity ${sequence}`},
              '{}',
              ${`2026-03-04T00:${String(Math.floor(sequence / 60)).padStart(2, "0")}:${String(sequence % 60).padStart(2, "0")}.000Z`},
              ${sequence}
            )
          `,
        { discard: true },
      );

      const metadataSnapshot = yield* snapshotQuery.getSnapshot({ hydrateThreadId: null });
      const metadataThread = metadataSnapshot.threads.find((thread) => thread.id === threadId);
      assert.deepEqual(metadataThread?.activities, []);

      yield* rebuildTimelineEntriesForThread(sql, threadId);
      const thread = Option.getOrThrow(yield* snapshotQuery.getThread(threadId));

      assert.equal(thread.activities.length, 0);

      const timelineSnapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(timelineSnapshot._tag, "Some");
      if (Option.isSome(timelineSnapshot)) {
        assert.equal(timelineSnapshot.value.totalRows, 0);
        assert.deepEqual(timelineSnapshot.value.rows, []);
        assert.deepEqual(timelineSnapshot.value.activities, []);
      }
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.makeUnsafe("thread-first"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.makeUnsafe("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.makeUnsafe("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              source: "git-checkpoint",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              source: "git-checkpoint",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );

  it.effect("reads complete thread timeline snapshots from projection tables", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_timeline_entries`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-timeline-page',
          'Timeline Project',
          '/tmp/timeline-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          queued_composer_messages_json,
          queued_steer_request_json,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-timeline-page',
          'project-timeline-page',
          'Timeline Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          '[]',
          NULL,
          'turn-timeline-page',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:10.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-timeline-page',
          'turn-timeline-page',
          NULL,
          NULL,
          NULL,
          'message-assistant',
          'completed',
          '2026-04-01T00:00:00.500Z',
          '2026-04-01T00:00:01.000Z',
          '2026-04-01T00:00:04.000Z',
          0,
          NULL,
          NULL,
          '[]'
        )
      `;

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
            'thread-timeline-page',
            'turn-timeline-page',
            'user',
            'Run checks',
            0,
            1,
            '2026-04-01T00:00:01.000Z',
            '2026-04-01T00:00:01.000Z'
          ),
          (
            'message-assistant',
            'thread-timeline-page',
            'turn-timeline-page',
            'assistant',
            'Done',
            0,
            4,
            '2026-04-01T00:00:04.000Z',
            '2026-04-01T00:00:04.000Z'
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
        VALUES
          (
            'activity-tool',
            'thread-timeline-page',
            'turn-timeline-page',
            'tool',
            'tool.completed',
            'Run command',
            '{"command":"bun lint"}',
            2,
            '2026-04-01T00:00:02.000Z'
          ),
          (
            'activity-null-payload',
            'thread-timeline-page',
            'turn-timeline-page',
            'tool',
            'tool.completed',
            'Run second command',
            'null',
            3,
            '2026-04-01T00:00:02.500Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-timeline-page',
          'turn-timeline-page',
          'Plan',
          NULL,
          NULL,
          '2026-04-01T00:00:03.000Z',
          '2026-04-01T00:00:03.000Z'
        )
      `;

      yield* rebuildTimelineEntriesForThread(sql, "thread-timeline-page");

      const snapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({
        threadId: ThreadId.makeUnsafe("thread-timeline-page"),
      });
      assert.equal(snapshot._tag, "Some");
      if (Option.isSome(snapshot)) {
        assert.equal(snapshot.value.totalRows, 4);
        assert.deepEqual(
          snapshot.value.rows.map((row) => `${row.startSourceIndex}:${row.kind}:${row.id}`),
          [
            "0:message:message:message-user",
            "1:work:activity:activity-tool",
            "3:proposed-plan:proposed-plan:plan-1",
            "4:message:message:message-assistant",
          ],
        );
        assert.deepEqual(
          snapshot.value.messages.map((message) => message.text),
          ["Run checks", "Done"],
        );
        assert.deepEqual(
          snapshot.value.activities.map((activity) => ({
            id: String(activity.id),
            payload: activity.payload,
            summary: activity.summary,
          })),
          [
            {
              id: "activity-tool",
              payload: { command: "bun lint" },
              summary: "Run command",
            },
          ],
        );
        assert.deepEqual(
          snapshot.value.proposedPlans.map((plan) => plan.id),
          ["plan-1"],
        );
      }

      yield* sql`
        DELETE FROM projection_thread_activities
        WHERE activity_id = 'activity-null-payload'
      `;
      yield* sql`
        DELETE FROM projection_thread_timeline_entries
        WHERE thread_id = 'thread-timeline-page'
          AND kind = 'activity'
          AND source_id = 'activity-null-payload'
      `;
      yield* sql`
        UPDATE projection_threads
        SET updated_at = '2026-04-01T00:00:11.000Z'
        WHERE thread_id = 'thread-timeline-page'
      `;
      const repairedSnapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({
        threadId: ThreadId.makeUnsafe("thread-timeline-page"),
      });
      assert.equal(repairedSnapshot._tag, "Some");
      if (Option.isSome(repairedSnapshot)) {
        assert.equal(repairedSnapshot.value.totalRows, 4);
        assert.equal(repairedSnapshot.value.updatedAt, "2026-04-01T00:00:11.000Z");
        assert.deepEqual(
          repairedSnapshot.value.rows.map((row) => `${row.startSourceIndex}:${row.kind}:${row.id}`),
          [
            "0:message:message:message-user",
            "1:work:activity:activity-tool",
            "2:proposed-plan:proposed-plan:plan-1",
            "3:message:message:message-assistant",
          ],
        );
        assert.deepEqual(
          repairedSnapshot.value.activities.map((activity) => activity.summary),
          ["Run command"],
        );
      }
    }),
  );

  it.effect("aggregates running turn work for public timeline snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-running-summary");

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_timeline_entries`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-running-summary',
          'Running Project',
          '/tmp/running-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          queued_composer_messages_json,
          queued_steer_request_json,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-running-summary',
          'project-running-summary',
          'Running Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          '[]',
          NULL,
          'turn-running-summary',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:05.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-running-summary',
          'turn-running-summary',
          NULL,
          NULL,
          NULL,
          'message-assistant-running',
          'running',
          '2026-04-02T00:00:01.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL,
          NULL,
          NULL,
          'pending',
          '[]'
        )
      `;

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
            'message-user-running',
            'thread-running-summary',
            'turn-running-summary',
            'user',
            'Run checks',
            0,
            1,
            '2026-04-02T00:00:01.000Z',
            '2026-04-02T00:00:01.000Z'
          ),
          (
            'message-assistant-running',
            'thread-running-summary',
            'turn-running-summary',
            'assistant',
            'Working',
            1,
            5,
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:05.000Z'
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
        VALUES
          (
            'activity-tool-one',
            'thread-running-summary',
            'turn-running-summary',
            'tool',
            'tool.completed',
            'Ran bun lint',
            '{"command":"bun lint","terminalOutput":"large output"}',
            2,
            '2026-04-02T00:00:02.000Z'
          ),
          (
            'activity-thinking',
            'thread-running-summary',
            'turn-running-summary',
            'info',
            'task.progress',
            'Thought about approach',
            '{"detail":"private reasoning"}',
            3,
            '2026-04-02T00:00:03.000Z'
          ),
          (
            'activity-tool-two',
            'thread-running-summary',
            'turn-running-summary',
            'tool',
            'tool.completed',
            'Ran bun typecheck',
            '{"command":"bun typecheck"}',
            4,
            '2026-04-02T00:00:04.000Z'
          )
      `;

      yield* rebuildTimelineEntriesForThread(sql, "thread-running-summary");

      const snapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(snapshot._tag, "Some");
      if (Option.isSome(snapshot)) {
        assert.equal(snapshot.value.totalRows, 3);
        assert.deepEqual(
          snapshot.value.rows.map((row) => `${row.startSourceIndex}:${row.kind}:${row.id}`),
          [
            "0:message:message:message-user-running",
            "3:work:activity:activity-tool-two",
            "4:message:message:message-assistant-running",
          ],
        );
        assert.deepEqual(
          snapshot.value.activities.map((activity) => ({
            id: String(activity.id),
            payload: activity.payload,
            summary: activity.summary,
          })),
          [
            {
              id: "activity-tool-two",
              payload: { command: "bun typecheck" },
              summary: "Ran bun typecheck",
            },
          ],
        );
      }
    }),
  );

  it.effect("derives completed latest turn work when the thread pointer is stale", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-stale-latest-turn");

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_timeline_entries`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-stale-latest-turn',
          'Stale Latest Turn Project',
          '/tmp/stale-latest-turn',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          queued_composer_messages_json,
          queued_steer_request_json,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          ${threadId},
          'project-stale-latest-turn',
          'Stale Latest Turn',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          '[]',
          NULL,
          NULL,
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:05.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          ${threadId},
          'turn-stale-latest-turn',
          NULL,
          NULL,
          NULL,
          'message-stale-assistant',
          'completed',
          '2026-04-03T00:00:00.500Z',
          '2026-04-03T00:00:01.000Z',
          '2026-04-03T00:00:04.000Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

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
            'message-stale-user',
            ${threadId},
            'turn-stale-latest-turn',
            'user',
            'Audit backend',
            0,
            1,
            '2026-04-03T00:00:01.000Z',
            '2026-04-03T00:00:01.000Z'
          ),
          (
            'message-stale-assistant',
            ${threadId},
            'turn-stale-latest-turn',
            'assistant',
            'Done',
            0,
            3,
            '2026-04-03T00:00:04.000Z',
            '2026-04-03T00:00:04.000Z'
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
          'activity-stale-tool',
          ${threadId},
          'turn-stale-latest-turn',
          'tool',
          'tool.completed',
          'Ran command',
          '{"command":"rg backend"}',
          2,
          '2026-04-03T00:00:02.000Z'
        )
      `;

      yield* rebuildTimelineEntriesForThread(sql, threadId);

      const snapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(snapshot._tag, "Some");
      if (Option.isSome(snapshot)) {
        assert.deepEqual(
          snapshot.value.rows.map((row) => row.kind),
          ["message", "work", "message"],
        );
        assert.deepEqual(
          snapshot.value.activities.map((activity) => ({
            id: String(activity.id),
            summary: activity.summary,
          })),
          [{ id: "activity-stale-tool", summary: "Ran command" }],
        );
      }
    }),
  );

  it.effect("reads large backend timeline snapshots without stale rows", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-large-cached-page");

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_timeline_entries`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-large-cached-page',
          'Large Cached Page Project',
          '/tmp/large-cached-page',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-05-01T00:00:00.000Z',
          '2026-05-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          queued_composer_messages_json,
          queued_steer_request_json,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-large-cached-page',
          'project-large-cached-page',
          'Large Cached Page Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          '[]',
          NULL,
          NULL,
          '2026-05-01T00:00:00.000Z',
          '2026-05-01T00:00:10.000Z',
          NULL
        )
      `;

      yield* sql`
        WITH RECURSIVE message_index(index_value) AS (
          SELECT 0
          UNION ALL
          SELECT index_value + 1
          FROM message_index
          WHERE index_value < 299
        )
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
        SELECT
          'message-large-' || index_value,
          'thread-large-cached-page',
          NULL,
          'assistant',
          'Large cached message ' || index_value,
          0,
          index_value,
          '2026-05-01T00:00:01.000Z',
          '2026-05-01T00:00:01.000Z'
        FROM message_index
      `;
      yield* rebuildTimelineEntriesForThread(sql, "thread-large-cached-page");

      const snapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(snapshot._tag, "Some");
      if (Option.isSome(snapshot)) {
        assert.equal(snapshot.value.totalRows, 300);
        assert.equal(snapshot.value.rows.length, 300);
        assert.equal(snapshot.value.messages.length, 300);
        assert.equal(snapshot.value.rows[0]?.id, "message:message-large-0");
        assert.equal(snapshot.value.rows.at(-1)?.id, "message:message-large-299");
        assert.equal(snapshot.value.messages[0]?.text, "Large cached message 0");
        assert.equal(snapshot.value.messages.at(-1)?.text, "Large cached message 299");
      }

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'Large cached message updated'
        WHERE message_id = 'message-large-0'
      `;

      const refreshedSnapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(refreshedSnapshot._tag, "Some");
      if (Option.isSome(refreshedSnapshot)) {
        assert.equal(refreshedSnapshot.value.messages[0]?.text, "Large cached message updated");
      }

      yield* sql`
        UPDATE projection_threads
        SET updated_at = '2026-05-01T00:00:11.000Z'
        WHERE thread_id = 'thread-large-cached-page'
      `;

      const invalidatedSnapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(invalidatedSnapshot._tag, "Some");
      if (Option.isSome(invalidatedSnapshot)) {
        assert.equal(invalidatedSnapshot.value.messages[0]?.text, "Large cached message updated");
      }
    }),
  );

  it.effect("reads complete timeline snapshots with interleaved event positions", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-timeline-page");

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_timeline_entries`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-timeline-page',
          'Timeline Page Project',
          '/tmp/timeline-page',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-03-04T00:00:00.000Z',
          '2026-03-04T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          queued_composer_messages_json,
          queued_steer_request_json,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-timeline-page',
          'project-timeline-page',
          'Timeline Page Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          '[]',
          NULL,
          NULL,
          '2026-03-04T00:00:00.000Z',
          '2026-03-04T00:00:10.000Z',
          NULL
        )
      `;

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
          updated_at,
          attachments_json
        )
        VALUES
          (
            'message-user',
            'thread-timeline-page',
            'turn-timeline-page',
            'user',
            'Run checks',
            0,
            1,
            '2026-03-04T00:00:01.000Z',
            '2026-03-04T00:00:01.000Z',
            NULL
          ),
          (
            'message-assistant',
            'thread-timeline-page',
            'turn-timeline-page',
            'assistant',
            'Done',
            0,
            4,
            '2026-03-04T00:00:04.000Z',
            '2026-03-04T00:00:04.000Z',
            NULL
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
          created_at,
          sequence
        )
        VALUES (
          'activity-tool',
          'thread-timeline-page',
          'turn-timeline-page',
          'tool',
          'tool.completed',
          'Run command',
          '{}',
          '2026-03-04T00:00:02.000Z',
          2
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-timeline',
          'thread-timeline-page',
          'turn-timeline-page',
          'Plan',
          NULL,
          NULL,
          '2026-03-04T00:00:03.000Z',
          '2026-03-04T00:00:03.000Z'
        )
      `;

      const initialSnapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(initialSnapshot._tag, "Some");
      if (Option.isSome(initialSnapshot)) {
        assert.equal(initialSnapshot.value.threadId, threadId);
        assert.equal(initialSnapshot.value.updatedAt, "2026-03-04T00:00:10.000Z");
        assert.equal(initialSnapshot.value.totalRows, 3);
        assert.deepEqual(
          initialSnapshot.value.rows.map((row) => `${row.startSourceIndex}:${row.kind}:${row.id}`),
          [
            "0:message:message:message-user",
            "2:proposed-plan:proposed-plan:plan-timeline",
            "3:message:message:message-assistant",
          ],
        );
      }

      const repairedTimelineRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_thread_timeline_entries
        WHERE thread_id = 'thread-timeline-page'
      `;
      assert.equal(repairedTimelineRows[0]?.count, 4);

      yield* sql`
        DELETE FROM projection_thread_timeline_entries
        WHERE thread_id = 'thread-timeline-page'
      `;
      const rebuiltSnapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(rebuiltSnapshot._tag, "Some");
      if (Option.isSome(rebuiltSnapshot)) {
        assert.equal(rebuiltSnapshot.value.totalRows, 3);
        assert.deepEqual(
          rebuiltSnapshot.value.rows.map((row) => `${row.startSourceIndex}:${row.kind}:${row.id}`),
          [
            "0:message:message:message-user",
            "2:proposed-plan:proposed-plan:plan-timeline",
            "3:message:message:message-assistant",
          ],
        );
      }

      yield* sql`
        UPDATE projection_thread_timeline_entries
        SET source_id = 'activity-missing'
        WHERE thread_id = 'thread-timeline-page'
          AND kind = 'activity'
          AND source_id = 'activity-tool'
      `;
      const repairedSnapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(repairedSnapshot._tag, "Some");
      if (Option.isSome(repairedSnapshot)) {
        assert.equal(repairedSnapshot.value.threadId, threadId);
        assert.equal(repairedSnapshot.value.revision.includes("thread-timeline-page:"), true);
        assert.equal(repairedSnapshot.value.updatedAt, "2026-03-04T00:00:10.000Z");
        assert.equal(repairedSnapshot.value.totalRows, 3);
        assert.deepEqual(
          repairedSnapshot.value.rows.map((row) => `${row.startSourceIndex}:${row.kind}:${row.id}`),
          [
            "0:message:message:message-user",
            "2:proposed-plan:proposed-plan:plan-timeline",
            "3:message:message:message-assistant",
          ],
        );
        assert.deepEqual(
          repairedSnapshot.value.rows.map((row) =>
            row.sourceRefs.map(
              (sourceRef) => `${sourceRef.sourceIndex}:${sourceRef.kind}:${sourceRef.id}`,
            ),
          ),
          [
            ["0:message:message-user"],
            ["2:proposed-plan:plan-timeline"],
            ["3:message:message-assistant"],
          ],
        );
        assert.deepEqual(
          repairedSnapshot.value.messages.map((message) => message.text),
          ["Run checks", "Done"],
        );
        assert.deepEqual(repairedSnapshot.value.activities, []);
        assert.deepEqual(
          repairedSnapshot.value.proposedPlans.map((plan) => plan.planMarkdown),
          ["Plan"],
        );
      }

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'Run checks updated'
        WHERE message_id = 'message-user'
      `;

      const refreshedSnapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(refreshedSnapshot._tag, "Some");
      if (Option.isSome(refreshedSnapshot)) {
        assert.deepEqual(
          refreshedSnapshot.value.messages.map((message) => message.text),
          ["Run checks updated", "Done"],
        );
      }

      yield* sql`
        UPDATE projection_threads
        SET updated_at = '2026-03-04T00:00:11.000Z'
        WHERE thread_id = 'thread-timeline-page'
      `;

      const invalidatedSnapshot = yield* snapshotQuery.getThreadTimelineRowsSnapshot({ threadId });
      assert.equal(invalidatedSnapshot._tag, "Some");
      if (Option.isSome(invalidatedSnapshot)) {
        assert.equal(invalidatedSnapshot.value.updatedAt, "2026-03-04T00:00:11.000Z");
        assert.deepEqual(
          invalidatedSnapshot.value.messages.map((message) => message.text),
          ["Run checks updated", "Done"],
        );
      }
    }),
  );
});
