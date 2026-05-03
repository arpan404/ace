import * as NodeServices from "@effect/platform-node/NodeServices";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  BASE_SERVER_PORT,
  BASE_WEB_PORT,
  MODE_ARGS,
  createDevRunnerEnv,
  findFirstAvailableOffset,
  resolveModePortOffsets,
  resolveOffset,
} from "./dev-runner.ts";

it.layer(NodeServices.layer)("dev-runner", (it) => {
  describe("resolveOffset", () => {
    it.effect("uses explicit ACE_PORT_OFFSET when provided", () =>
      Effect.sync(() => {
        const result = resolveOffset({ portOffset: 12, devInstance: undefined });
        assert.deepStrictEqual(result, {
          offset: 12,
          source: "ACE_PORT_OFFSET=12",
        });
      }),
    );

    it.effect("hashes non-numeric instance values", () =>
      Effect.sync(() => {
        const result = resolveOffset({ portOffset: undefined, devInstance: "feature-branch" });
        assert.ok(result.offset >= 1);
        assert.ok(result.offset <= 3000);
      }),
    );

    it.effect("throws for negative port offset", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Effect.try({
            try: () => resolveOffset({ portOffset: -1, devInstance: undefined }),
            catch: (cause) => String(cause),
          }),
        );

        assert.ok(error.includes("Invalid ACE_PORT_OFFSET"));
      }),
    );
  });

  describe("createDevRunnerEnv", () => {
    it.effect("defaults ACE_HOME to ~/.ace/dev when not provided", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          aceHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.ACE_HOME, resolve(homedir(), ".ace", "dev"));
        assert.equal(env.ACE_DAEMONIZED, "1");
      }),
    );

    it.effect("defaults ACE_HOME to ~/.ace/dev/desktop for dev:desktop when not provided", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          aceHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.ACE_HOME, resolve(homedir(), ".ace", "dev", "desktop"));
        assert.equal(env.ACE_DAEMONIZED, undefined);
      }),
    );

    it.effect("defaults ACE_HOME to ~/.ace/dev/web for dev:web when not provided", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:web",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          aceHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.ACE_HOME, resolve(homedir(), ".ace", "dev", "web"));
        assert.equal(env.ACE_DAEMONIZED, "1");
      }),
    );

    it.effect("supports explicit typed overrides", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:server",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          aceHome: "/tmp/custom-ace",
          authToken: "secret",
          noBrowser: true,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
          host: "0.0.0.0",
          port: 4222,
          devUrl: new URL("http://localhost:7331"),
        });

        assert.equal(env.ACE_HOME, resolve("/tmp/custom-ace"));
        assert.equal(env.ACE_PORT, "4222");
        assert.equal(env.VITE_WS_URL, "ws://localhost:4222");
        assert.equal(env.ACE_NO_BROWSER, "1");
        assert.equal(env.ACE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
        assert.equal(env.ACE_LOG_WS_EVENTS, "1");
        assert.equal(env.ACE_HOST, "0.0.0.0");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://localhost:7331/");
        assert.equal(env.ACE_DAEMONIZED, "1");
      }),
    );

    it.effect("does not force websocket logging on in dev mode when unset", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            ACE_LOG_WS_EVENTS: "keep-me-out",
          },
          serverOffset: 0,
          webOffset: 0,
          aceHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.ACE_MODE, "web");
        assert.equal(env.ACE_LOG_WS_EVENTS, undefined);
      }),
    );

    it.effect("treats dev:mobile like web runtime wiring", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:mobile",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          aceHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.ACE_MODE, "web");
        assert.equal(env.ACE_DAEMONIZED, "1");
        assert.equal(env.EXPO_PUBLIC_ACE_PORT, String(BASE_SERVER_PORT));
      }),
    );

    it.effect("forwards explicit mobile host metadata to Expo", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:mobile",
          baseEnv: {},
          serverOffset: 4,
          webOffset: 4,
          aceHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: "192.168.1.24",
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.EXPO_PUBLIC_ACE_HOST, "192.168.1.24");
        assert.equal(env.EXPO_PUBLIC_ACE_PORT, String(BASE_SERVER_PORT + 4));
      }),
    );

    it.effect("does not publish wildcard bind addresses as mobile connect hosts", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:mobile",
          baseEnv: {
            EXPO_PUBLIC_ACE_HOST: "stale-host",
          },
          serverOffset: 0,
          webOffset: 0,
          aceHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: "0.0.0.0",
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.EXPO_PUBLIC_ACE_HOST, undefined);
      }),
    );

    it.effect("forwards explicit websocket logging false without coercing it away", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          aceHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: false,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.ACE_LOG_WS_EVENTS, "0");
      }),
    );

    it.effect("uses custom aceHome when provided", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          aceHome: "/tmp/my-ace",
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.ACE_HOME, resolve("/tmp/my-ace"));
      }),
    );

    it.effect("does not export backend bootstrap env for dev:desktop", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: {
            ACE_PORT: String(BASE_SERVER_PORT),
            ACE_AUTH_TOKEN: "stale-token",
            ACE_MODE: "web",
            ACE_NO_BROWSER: "0",
            ACE_HOST: "0.0.0.0",
            VITE_WS_URL: `ws://localhost:${String(BASE_SERVER_PORT)}`,
          },
          serverOffset: 0,
          webOffset: 0,
          aceHome: "/tmp/my-ace",
          authToken: "fresh-token",
          noBrowser: true,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: "127.0.0.1",
          port: 4222,
          devUrl: undefined,
        });

        assert.equal(env.ACE_HOME, resolve("/tmp/my-ace"));
        assert.equal(env.PORT, String(BASE_WEB_PORT));
        assert.equal(env.ELECTRON_RENDERER_PORT, String(BASE_WEB_PORT));
        assert.equal(env.VITE_DEV_SERVER_URL, `http://localhost:${String(BASE_WEB_PORT)}`);
        assert.equal(env.ACE_PORT, undefined);
        assert.equal(env.ACE_AUTH_TOKEN, undefined);
        assert.equal(env.ACE_MODE, undefined);
        assert.equal(env.ACE_NO_BROWSER, undefined);
        assert.equal(env.ACE_HOST, undefined);
        assert.equal(env.VITE_WS_URL, undefined);
        assert.equal(env.ACE_DAEMONIZED, undefined);
      }),
    );
  });

  describe("findFirstAvailableOffset", () => {
    it.effect("returns the starting offset when required ports are available", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 0);
      }),
    );

    it.effect("advances until all required ports are available", () =>
      Effect.gen(function* () {
        const taken = new Set([
          BASE_SERVER_PORT,
          BASE_WEB_PORT,
          BASE_SERVER_PORT + 1,
          BASE_WEB_PORT + 1,
        ]);
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.equal(offset, 2);
      }),
    );

    it.effect("allows offsets where only non-required ports exceed max", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 59_803,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 59_803);
      }),
    );
  });

  describe("resolveModePortOffsets", () => {
    it.effect("starts the backend in dev:mobile", () =>
      Effect.sync(() => {
        assert.ok(MODE_ARGS["dev:mobile"].includes("--filter=ace"));
      }),
    );

    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([BASE_SERVER_PORT, BASE_WEB_PORT]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("uses a shared fallback offset for dev:web", () =>
      Effect.gen(function* () {
        const taken = new Set([BASE_WEB_PORT]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([BASE_SERVER_PORT]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("uses a shared fallback offset for dev:mobile", () =>
      Effect.gen(function* () {
        const taken = new Set([BASE_SERVER_PORT, BASE_WEB_PORT]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:mobile",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect(
      "respects explicit dev-url override for dev:web while still checking server port",
      () =>
        Effect.gen(function* () {
          const offsets = yield* resolveModePortOffsets({
            mode: "dev:web",
            startOffset: 0,
            hasExplicitServerPort: false,
            hasExplicitDevUrl: true,
            checkPortAvailability: () => Effect.succeed(true),
          });

          assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
        }),
    );

    it.effect("respects explicit server port override for dev:server", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: true,
          hasExplicitDevUrl: false,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );
  });
});
