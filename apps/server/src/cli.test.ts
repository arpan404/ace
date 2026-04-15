import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@ace/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as CliError from "effect/unstable/cli/CliError";
import { Command } from "effect/unstable/cli";

import type { AceServerDaemonState } from "./daemon";
import {
  applyDaemonRestartStateDefaults,
  cli,
  isDaemonStateCurrentVersion,
  shouldRunServeInForeground,
} from "./cli.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

it.layer(NodeServices.layer)("cli log-level parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    Command.runWith(cli, { version: "0.0.0" })(["--log-level", "debug", "--version"]).pipe(
      Effect.provide(CliRuntimeLayer),
    ),
  );

  it.effect("rejects invalid log-level casing before launching the server", () =>
    Effect.gen(function* () {
      const error = yield* Command.runWith(cli, { version: "0.0.0" })([
        "--log-level",
        "Debug",
      ]).pipe(Effect.provide(CliRuntimeLayer), Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${error._tag}`);
      }
      assert.equal(error.option, "log-level");
      assert.equal(error.value, "Debug");
    }),
  );

  it.effect("recognizes daemon restart command", () =>
    Command.runWith(cli, { version: "0.0.0" })(["daemon", "restart", "--help"]).pipe(
      Effect.provide(CliRuntimeLayer),
    ),
  );

  it.effect("recognizes interactive command", () =>
    Command.runWith(cli, { version: "0.0.0" })(["interactive", "--help"]).pipe(
      Effect.provide(CliRuntimeLayer),
    ),
  );

  it.effect("recognizes web command", () =>
    Command.runWith(cli, { version: "0.0.0" })(["web", "--help"]).pipe(
      Effect.provide(CliRuntimeLayer),
    ),
  );

  it.effect("recognizes profile command", () =>
    Command.runWith(cli, { version: "0.0.0" })(["profile", "--help"]).pipe(
      Effect.provide(CliRuntimeLayer),
    ),
  );

  it.effect("applies daemon restart defaults from existing daemon state", () =>
    Effect.sync(() => {
      const existingState: AceServerDaemonState = {
        version: 1,
        pid: 1234,
        serverVersion: "0.0.15",
        mode: "desktop",
        host: "0.0.0.0",
        port: 4781,
        wsUrl: "ws://127.0.0.1:4781/?token=abc123",
        authToken: "abc123",
        baseDir: "/tmp/ace",
        dbPath: "/tmp/ace/state/db.sqlite",
        serverLogPath: "/tmp/ace/state/logs/server.log",
        startedAt: "2026-04-14T00:00:00.000Z",
        updatedAt: "2026-04-14T00:00:00.000Z",
      };
      const applied = applyDaemonRestartStateDefaults(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.some(true),
          authToken: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        existingState,
      );

      assert.equal(Option.isSome(applied.mode), true);
      assert.equal(Option.isSome(applied.port), true);
      assert.equal(Option.isSome(applied.host), true);
      assert.equal(Option.isSome(applied.authToken), true);
      if (Option.isSome(applied.mode)) {
        assert.equal(applied.mode.value, "desktop");
      }
      if (Option.isSome(applied.port)) {
        assert.equal(applied.port.value, 4781);
      }
      if (Option.isSome(applied.host)) {
        assert.equal(applied.host.value, "0.0.0.0");
      }
      if (Option.isSome(applied.authToken)) {
        assert.equal(applied.authToken.value, "abc123");
      }
    }),
  );

  it.effect("keeps explicit daemon restart flags instead of inherited state", () =>
    Effect.sync(() => {
      const applied = applyDaemonRestartStateDefaults(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.some("127.0.0.1"),
          baseDir: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.some(true),
          authToken: Option.some("explicit-token"),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        {
          version: 1,
          pid: 100,
          serverVersion: "0.0.14",
          mode: "desktop",
          host: "0.0.0.0",
          port: 4781,
          wsUrl: "ws://127.0.0.1:4781/?token=inherited-token",
          authToken: "inherited-token",
          baseDir: "/tmp/ace",
          dbPath: "/tmp/ace/state/db.sqlite",
          serverLogPath: "/tmp/ace/state/logs/server.log",
          startedAt: "2026-04-14T00:00:00.000Z",
          updatedAt: "2026-04-14T00:00:00.000Z",
        },
      );

      assert.equal(Option.isSome(applied.mode), true);
      assert.equal(Option.isSome(applied.port), true);
      assert.equal(Option.isSome(applied.host), true);
      assert.equal(Option.isSome(applied.authToken), true);
      if (Option.isSome(applied.mode)) {
        assert.equal(applied.mode.value, "web");
      }
      if (Option.isSome(applied.port)) {
        assert.equal(applied.port.value, 3773);
      }
      if (Option.isSome(applied.host)) {
        assert.equal(applied.host.value, "127.0.0.1");
      }
      if (Option.isSome(applied.authToken)) {
        assert.equal(applied.authToken.value, "explicit-token");
      }
    }),
  );

  it.effect("detects whether daemon state matches the running server version", () =>
    Effect.sync(() => {
      assert.equal(isDaemonStateCurrentVersion(null, "1.2.3"), false);
      assert.equal(
        isDaemonStateCurrentVersion(
          {
            version: 1,
            pid: 100,
            serverVersion: "1.2.3",
            mode: "desktop",
            host: "127.0.0.1",
            port: 3773,
            wsUrl: "ws://127.0.0.1:3773/?token=token",
            authToken: "token",
            baseDir: "/tmp/ace",
            dbPath: "/tmp/ace/state/db.sqlite",
            serverLogPath: "/tmp/ace/state/logs/server.log",
            startedAt: "2026-04-14T00:00:00.000Z",
            updatedAt: "2026-04-14T00:00:00.000Z",
          },
          "1.2.3",
        ),
        true,
      );
      assert.equal(
        isDaemonStateCurrentVersion(
          {
            version: 1,
            pid: 100,
            serverVersion: "1.2.2",
            mode: "desktop",
            host: "127.0.0.1",
            port: 3773,
            wsUrl: "ws://127.0.0.1:3773/?token=token",
            authToken: "token",
            baseDir: "/tmp/ace",
            dbPath: "/tmp/ace/state/db.sqlite",
            serverLogPath: "/tmp/ace/state/logs/server.log",
            startedAt: "2026-04-14T00:00:00.000Z",
            updatedAt: "2026-04-14T00:00:00.000Z",
          },
          "1.2.3",
        ),
        false,
      );
    }),
  );

  it.effect("runs daemonized serve processes in the foreground server mode", () =>
    Effect.sync(() => {
      assert.equal(shouldRunServeInForeground({}), false);
      assert.equal(shouldRunServeInForeground({ ACE_DAEMONIZED: "0" }), false);
      assert.equal(shouldRunServeInForeground({ ACE_DAEMONIZED: "1" }), true);
    }),
  );
});
