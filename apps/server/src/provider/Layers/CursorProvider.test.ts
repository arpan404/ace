import assert from "node:assert/strict";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, it } from "vitest";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  checkCursorProviderStatus,
  parseCursorAuthStatus,
  parseCursorModelsOutput,
  resolveCursorCliModelId,
} from "./CursorProvider.ts";

const CODEX_MAX_MODELS_OUTPUT = `
gpt-5.1-codex-max-low - GPT-5.1 Codex Max Low
gpt-5.1-codex-max - GPT-5.1 Codex Max
gpt-5.1-codex-max-high-fast - GPT-5.1 Codex Max High Fast
gpt-5.1-codex-max-xhigh - GPT-5.1 Codex Max Extra High
`;

const HIGH_ONLY_MODELS_OUTPUT = `
gpt-5.3-codex-high - GPT-5.3 Codex High
gpt-5.3-codex-xhigh - GPT-5.3 Codex Extra High
`;

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

async function runStatusCheck(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Effect.runPromise(
    checkCursorProviderStatus().pipe(
      Effect.provide(
        Layer.mergeAll(
          mockCommandSpawnerLayer(handler),
          ServerSettingsService.layerTest({
            providers: {
              cursor: {
                enabled: true,
                binaryPath: "cursor-agent",
                customModels: [],
              },
            },
          }),
        ),
      ),
    ),
  );
}

describe("CursorProvider", () => {
  it("parses Cursor auth status JSON", () => {
    assert.deepEqual(
      parseCursorAuthStatus(`{
        "status": "authenticated",
        "isAuthenticated": true,
        "userInfo": {
          "email": "user@example.com"
        }
      }`),
      {
        status: "ready",
        auth: {
          status: "authenticated",
          label: "user@example.com",
        },
      },
    );
  });

  it("checks Cursor auth with status JSON instead of about", async () => {
    const calls: string[][] = [];
    const provider = await runStatusCheck((command, args) => {
      assert.equal(command, "cursor-agent");
      calls.push([...args]);
      switch (args.join(" ")) {
        case "--version":
          return { stdout: "2026.05.20-2b5dd59\n", stderr: "", code: 0 };
        case "models":
          return { stdout: "composer-2 - Composer 2\n", stderr: "", code: 0 };
        case "status --format json":
          return {
            stdout: JSON.stringify({
              status: "authenticated",
              isAuthenticated: true,
              userInfo: { email: "user@example.com" },
            }),
            stderr: "",
            code: 0,
          };
        default:
          throw new Error(`Unexpected Cursor command: ${args.join(" ")}`);
      }
    });

    assert.deepEqual(calls, [["--version"], ["models"], ["status", "--format", "json"]]);
    assert.equal(provider.status, "ready");
    assert.deepEqual(provider.auth, {
      status: "authenticated",
      label: "user@example.com",
    });
  });

  it("treats successful Cursor model discovery as authenticated when auth output is unparseable", async () => {
    const provider = await runStatusCheck((_command, args) => {
      switch (args.join(" ")) {
        case "--version":
          return { stdout: "2026.05.20-2b5dd59\n", stderr: "", code: 0 };
        case "models":
          return { stdout: "composer-2 - Composer 2\n", stderr: "", code: 0 };
        case "status --format json":
          return { stdout: "", stderr: "unknown option: --format\n", code: 1 };
        default:
          throw new Error(`Unexpected Cursor command: ${args.join(" ")}`);
      }
    });

    assert.equal(provider.status, "ready");
    assert.deepEqual(provider.auth, { status: "authenticated" });
    assert.equal(provider.message, undefined);
  });

  it("keeps Codex Max variants grouped under the Codex Max family", () => {
    const models = parseCursorModelsOutput(CODEX_MAX_MODELS_OUTPUT);

    assert.deepEqual(
      models.map((model) => ({
        slug: model.slug,
        familySlug: model.cursorMetadata?.familySlug,
        familyName: model.cursorMetadata?.familyName,
        reasoningEffort: model.cursorMetadata?.reasoningEffort,
        fastMode: model.cursorMetadata?.fastMode,
        maxMode: model.cursorMetadata?.maxMode,
      })),
      [
        {
          slug: "gpt-5.1-codex-max-low",
          familySlug: "gpt-5.1-codex-max",
          familyName: "GPT-5.1 Codex Max",
          reasoningEffort: "low",
          fastMode: false,
          maxMode: false,
        },
        {
          slug: "gpt-5.1-codex-max",
          familySlug: "gpt-5.1-codex-max",
          familyName: "GPT-5.1 Codex Max",
          reasoningEffort: undefined,
          fastMode: false,
          maxMode: false,
        },
        {
          slug: "gpt-5.1-codex-max-high-fast",
          familySlug: "gpt-5.1-codex-max",
          familyName: "GPT-5.1 Codex Max",
          reasoningEffort: "high",
          fastMode: true,
          maxMode: false,
        },
        {
          slug: "gpt-5.1-codex-max-xhigh",
          familySlug: "gpt-5.1-codex-max",
          familyName: "GPT-5.1 Codex Max",
          reasoningEffort: "xhigh",
          fastMode: false,
          maxMode: false,
        },
      ],
    );

    assert.deepEqual(models[0]?.capabilities, {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High", isDefault: false },
        { value: "high", label: "High", isDefault: false },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "low", label: "Low", isDefault: false },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    });

    assert.equal(
      resolveCursorCliModelId({
        model: "gpt-5.1-codex-max",
        options: { reasoningEffort: "high", fastMode: true },
      }),
      "gpt-5.1-codex-max-high-fast",
    );
  });

  it("marks the lowest discovered Cursor effort as the default when no base variant exists", () => {
    const models = parseCursorModelsOutput(HIGH_ONLY_MODELS_OUTPUT);

    assert.deepEqual(models[0]?.capabilities?.reasoningEffortLevels, [
      { value: "xhigh", label: "Extra High", isDefault: false },
      { value: "high", label: "High", isDefault: true },
    ]);
  });
});
