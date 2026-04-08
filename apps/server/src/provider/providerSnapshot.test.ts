import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, Option, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { spawnAndCollect } from "./providerSnapshot";

describe("providerSnapshot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kills timed out provider probes during scope cleanup", async () => {
    let killed = false;
    const processKill = vi.spyOn(process, "kill").mockImplementation(((
      _pid: number | NodeJS.Signals,
      _signal?: number | NodeJS.Signals,
    ) => {
      killed = true;
      return true;
    }) as typeof process.kill);

    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.suspend(() =>
        killed
          ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
          : (Effect.never as Effect.Effect<ChildProcessSpawner.ExitCode>),
      ),
      isRunning: Effect.sync(() => !killed),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.succeed(handle)),
    );

    const result = await Effect.runPromise(
      spawnAndCollect(
        "claude",
        ChildProcess.make("claude", ["auth", "status"], {
          shell: false,
        }),
      ).pipe(Effect.timeoutOption(5), Effect.provide(spawnerLayer)),
    );

    expect(Option.isNone(result)).toBe(true);
    expect(processKill).toHaveBeenCalledWith(4242, "SIGTERM");
  });
});
