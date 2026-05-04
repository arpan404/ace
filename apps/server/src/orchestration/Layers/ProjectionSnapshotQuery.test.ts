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

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
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
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.makeUnsafe("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          latestProposedPlanSummary: {
            id: "plan-1",
            turnId: asTurnId("turn-1"),
            implementedAt: "2026-02-24T00:00:05.500Z",
            implementationThreadId: ThreadId.makeUnsafe("thread-2"),
            createdAt: "2026-02-24T00:00:05.000Z",
            updatedAt: "2026-02-24T00:00:05.500Z",
          },
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              source: "git-checkpoint",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
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

  it.effect(
    "supports lean snapshots and single-thread hydration without loading all thread history",
    () =>
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
              '{"stage":"running"}',
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

        const leanSnapshot = yield* snapshotQuery.getSnapshot({ hydrateThreadId: null });
        const leanThread1 = leanSnapshot.threads.find(
          (thread) => thread.id === ThreadId.makeUnsafe("thread-1"),
        );
        const leanThread2 = leanSnapshot.threads.find(
          (thread) => thread.id === ThreadId.makeUnsafe("thread-2"),
        );

        assert.equal(leanThread1 !== undefined, true);
        assert.equal(leanThread2 !== undefined, true);
        assert.deepEqual(
          leanThread1?.messages.map((message) => message.id),
          [asMessageId("thread-1-user")],
        );
        assert.equal(leanThread1?.latestTurn?.turnId, asTurnId("turn-1"));
        assert.deepEqual(
          leanThread1?.activities.map((activity) => activity.id),
          [asEventId("thread-1-approval")],
        );
        assert.deepEqual(leanThread1?.checkpoints, []);
        assert.deepEqual(
          leanThread2?.messages.map((message) => message.id),
          [asMessageId("thread-2-user")],
        );
        assert.deepEqual(
          leanThread2?.activities.map((activity) => activity.id),
          [asEventId("thread-2-user-input")],
        );
        assert.deepEqual(leanThread2?.proposedPlans, []);
        assert.deepEqual(leanThread2?.latestProposedPlanSummary, {
          id: "plan-1",
          turnId: null,
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-03-03T00:00:09.000Z",
          updatedAt: "2026-03-03T00:00:09.000Z",
        });

        const hydratedSnapshot = yield* snapshotQuery.getSnapshot({
          hydrateThreadId: ThreadId.makeUnsafe("thread-1"),
        });
        const hydratedThread1 = hydratedSnapshot.threads.find(
          (thread) => thread.id === ThreadId.makeUnsafe("thread-1"),
        );
        const hydratedThread2 = hydratedSnapshot.threads.find(
          (thread) => thread.id === ThreadId.makeUnsafe("thread-2"),
        );

        assert.deepEqual(
          hydratedThread1?.messages.map((message) => message.id),
          [
            asMessageId("thread-1-user-earlier"),
            asMessageId("thread-1-user"),
            asMessageId("thread-1-assistant"),
          ],
        );
        assert.equal(hydratedThread1?.latestTurn?.turnId, asTurnId("turn-1"));
        assert.deepEqual(
          hydratedThread1?.activities.map((activity) => activity.id),
          [asEventId("thread-1-approval"), asEventId("thread-1-runtime-note")],
        );
        assert.equal(hydratedThread1?.checkpoints.length, 1);
        assert.deepEqual(
          hydratedThread2?.messages.map((message) => message.id),
          [asMessageId("thread-2-user")],
        );
        assert.deepEqual(
          hydratedThread2?.activities.map((activity) => activity.id),
          [asEventId("thread-2-user-input")],
        );
        assert.deepEqual(hydratedThread2?.checkpoints, []);
        assert.deepEqual(hydratedThread2?.proposedPlans, []);
        assert.equal(hydratedThread2?.latestProposedPlanSummary?.id, "plan-1");

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
          [asEventId("thread-1-approval"), asEventId("thread-1-runtime-note")],
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
});
