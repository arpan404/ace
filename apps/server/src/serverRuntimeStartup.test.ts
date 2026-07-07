import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Ref } from "effect";

import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  launchStartupHeartbeat,
  makeCommandGate,
  ServerRuntimeStartupError,
} from "./serverRuntimeStartup.ts";

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartupError({
          message: "startup failed",
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "startup failed");
    }),
  ),
);

it.effect("enqueueCommand rejects excess work while startup is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const previousCapacity = process.env.ACE_STARTUP_COMMAND_QUEUE_CAPACITY;
      process.env.ACE_STARTUP_COMMAND_QUEUE_CAPACITY = "1";

      try {
        const commandGate = yield* makeCommandGate;

        const firstQueuedCommand = yield* commandGate
          .enqueueCommand(Effect.void)
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const rejected = yield* Effect.flip(commandGate.enqueueCommand(Effect.void));
        assert.equal(
          rejected.message,
          "Server startup command queue is full (1). Try again after startup completes.",
        );

        yield* commandGate.signalCommandReady;
        yield* Fiber.join(firstQueuedCommand);
      } finally {
        if (previousCapacity === undefined) {
          delete process.env.ACE_STARTUP_COMMAND_QUEUE_CAPACITY;
        } else {
          process.env.ACE_STARTUP_COMMAND_QUEUE_CAPACITY = previousCapacity;
        }
      }
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getThread: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        }),
        Effect.provideService(AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
        Effect.provideService(ProviderSessionDirectory, {
          upsert: () => Effect.void,
          getProvider: () => Effect.die("unused"),
          getBinding: () => Effect.succeed(Option.none()),
          remove: () => Effect.void,
          listThreadIds: () => Effect.succeed([]),
        }),
      );
    }),
  ),
);
