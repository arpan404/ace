import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { ServerProvider } from "@ace/contracts";

import { makeManagedServerProvider } from "./makeManagedServerProvider";

function pendingSnapshot(): ServerProvider {
  return {
    provider: "codex",
    enabled: true,
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    message: "Checking Codex availability...",
    models: [],
  };
}

function readySnapshot(): ServerProvider {
  return {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-01-01T00:00:01.000Z",
    models: [],
  };
}

describe("makeManagedServerProvider", () => {
  it("runs the first probe even when settings are unchanged", async () => {
    let probeCount = 0;
    const run = Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* makeManagedServerProvider<{ enabled: boolean }>({
          label: "Codex",
          getSettings: Effect.succeed({ enabled: true }),
          initialSnapshot: () => pendingSnapshot(),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          checkProvider: Effect.sync(() => {
            probeCount += 1;
            return readySnapshot();
          }),
        });

        const firstSnapshot = yield* provider.getSnapshot;
        const secondSnapshot = yield* provider.getSnapshot;
        return { firstSnapshot, secondSnapshot };
      }),
    );

    const result = await Effect.runPromise(run);
    expect(result.firstSnapshot.status).toBe("ready");
    expect(result.secondSnapshot.status).toBe("ready");
    expect(probeCount).toBe(1);
  });
});
