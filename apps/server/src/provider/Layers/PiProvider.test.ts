import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { Effect, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

import { ServerSettingsService } from "../../serverSettings.ts";
import { checkPiProviderStatus } from "./PiProvider.ts";

const mockedSpawn = vi.mocked(spawn);

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(result.stdout)),
    stderr: Stream.make(new TextEncoder().encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockCommandSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { command: string; args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

function makeRpcDiscoveryChild(input: {
  readonly responseLine?: Record<string, unknown>;
  readonly stderr?: string;
  readonly closeCode?: number;
}) {
  const emitter = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  const child = {
    stdin,
    stdout,
    stderr,
    on: vi.fn((event: string, handler: (...args: ReadonlyArray<unknown>) => void) => {
      emitter.on(event, handler);
      return child;
    }),
    kill: vi.fn(() => {
      emitter.emit("close", 0, null);
      return true;
    }),
  } as unknown as ReturnType<typeof spawn>;

  const originalWrite = stdin.write.bind(stdin);
  stdin.write = ((chunk: string | Uint8Array) => {
    const result = originalWrite(chunk as never);
    if (input.responseLine) {
      setImmediate(() => {
        stdout.write(`${JSON.stringify(input.responseLine)}\n`);
      });
    }
    return result;
  }) as typeof stdin.write;

  const originalEnd = stdin.end.bind(stdin);
  stdin.end = (() => {
    const result = originalEnd();
    if (!input.responseLine) {
      setImmediate(() => {
        if (input.stderr) {
          stderr.write(input.stderr);
        }
        emitter.emit("close", input.closeCode ?? 1, null);
      });
    }
    return result;
  }) as typeof stdin.end;

  return child;
}

async function withControlledPiAgentDir<T>(run: (dir: string) => Promise<T>) {
  const original = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), "ace-pi-provider-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (original === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = original;
    }
  }
}

async function runStatusCheck(
  settingsOverrides: Parameters<typeof ServerSettingsService.layerTest>[0],
  spawnerLayer: ReturnType<typeof mockCommandSpawnerLayer>,
) {
  const settingsLayer = ServerSettingsService.layerTest({
    providers: {
      pi: {
        enabled: true,
        binaryPath: "pi",
        customModels: [],
        ...settingsOverrides?.providers?.pi,
      },
    },
  });

  return Effect.runPromise(
    checkPiProviderStatus().pipe(Effect.provide(Layer.mergeAll(spawnerLayer, settingsLayer))),
  );
}

afterEach(() => {
  mockedSpawn.mockReset();
});

describe("checkPiProviderStatus", () => {
  it("reports a ready Pi provider when the CLI and RPC model discovery succeed", async () => {
    mockedSpawn.mockReturnValue(
      makeRpcDiscoveryChild({
        responseLine: {
          type: "response",
          command: "get_available_models",
          success: true,
          data: {
            models: [{ id: "gpt-5.5", provider: "openai", name: "GPT-5.5" }],
          },
        },
      }),
    );

    await withControlledPiAgentDir(async () => {
      const provider = await runStatusCheck(
        {
          providers: {
            pi: {
              customModels: ["openai/custom-preview"],
            },
          },
        },
        mockCommandSpawnerLayer((command, args) => {
          expect(command).toBe("pi");
          expect(args).toEqual(["--version"]);
          return {
            stdout: "pi 1.2.3\n",
            stderr: "",
            code: 0,
          };
        }),
      );

      expect(provider.status).toBe("ready");
      expect(provider.installed).toBe(true);
      expect(provider.version).toBe("1.2.3");
      expect(provider.runtimes).toEqual([
        expect.objectContaining({
          id: "pi",
          binaryPath: "pi",
          installed: true,
          version: "1.2.3",
          packageName: "@mariozechner/pi-coding-agent",
        }),
      ]);
      expect(provider.models).toEqual([
        {
          slug: "openai/gpt-5.5",
          name: "GPT-5.5",
          isCustom: false,
          capabilities: null,
        },
        {
          slug: "openai/custom-preview",
          name: "openai/custom-preview",
          isCustom: true,
          capabilities: null,
        },
      ]);
      expect(provider.message).toBe(
        "Pi detected. Authentication is verified when a session starts.",
      );
    });
  });

  it("reports a missing Pi runtime when the CLI is unavailable", async () => {
    await withControlledPiAgentDir(async () => {
      const provider = await runStatusCheck(
        {
          providers: {
            pi: {
              customModels: ["openai/custom-preview"],
            },
          },
        },
        failingSpawnerLayer("spawn pi ENOENT"),
      );

      expect(provider.status).toBe("error");
      expect(provider.installed).toBe(false);
      expect(provider.version).toBeNull();
      expect(provider.message).toBe("Missing required Pi runtime: Pi CLI (`pi`).");
      expect(provider.models).toEqual([
        {
          slug: "openai/custom-preview",
          name: "openai/custom-preview",
          isCustom: true,
          capabilities: null,
        },
      ]);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });
  });

  it("falls back to local Pi model settings when RPC discovery fails", async () => {
    mockedSpawn.mockReturnValue(
      makeRpcDiscoveryChild({
        stderr: "rpc unavailable",
        closeCode: 1,
      }),
    );

    await withControlledPiAgentDir(async () => {
      const provider = await runStatusCheck(
        {
          providers: {
            pi: {
              customModels: ["openai/custom-preview"],
            },
          },
        },
        mockCommandSpawnerLayer(() => ({
          stdout: "pi 1.2.3\n",
          stderr: "",
          code: 0,
        })),
      );

      expect(provider.status).toBe("ready");
      expect(provider.installed).toBe(true);
      expect(provider.models).toEqual([
        {
          slug: "openai/custom-preview",
          name: "openai/custom-preview",
          isCustom: true,
          capabilities: null,
        },
      ]);
      expect(provider.message).toBe(
        "Pi detected. Falling back to local model settings because RPC discovery failed.",
      );
    });
  });
});
