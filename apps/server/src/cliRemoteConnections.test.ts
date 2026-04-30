import * as NodeServices from "@effect/platform-node/NodeServices";
import { buildRelayHostConnectionDraft } from "@ace/shared/hostConnections";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import {
  addCliRemoteConnection,
  CliRemoteConnectionServicesLive,
  listCliRemoteConnections,
  removeCliRemoteConnection,
} from "./cliRemoteConnections";

async function createCliRemoteSystem() {
  const runtime = ManagedRuntime.make(
    CliRemoteConnectionServicesLive.pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "ace-cli-remotes-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  return {
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      runtime.runPromise(effect as Effect.Effect<A, E, never>),
    dispose: () => runtime.dispose(),
  };
}

describe("cliRemoteConnections", () => {
  it("adds and updates remote connections by normalized ws url", async () => {
    const system = await createCliRemoteSystem();

    const created = await system.run(
      addCliRemoteConnection({
        wsUrl: "http://localhost:3773",
        authToken: "token-1",
        name: "Local dev",
      }),
    );
    expect(created.status).toBe("created");
    expect(created.connection.name).toBe("Local dev");
    expect(created.connection.wsUrl).toContain("ws://localhost:3773/ws");

    const updated = await system.run(
      addCliRemoteConnection({
        wsUrl: "ws://localhost:3773/ws",
        authToken: "token-2",
      }),
    );
    expect(updated.status).toBe("updated");
    expect(updated.connection.id).toBe(created.connection.id);
    expect(updated.connection.authToken).toBe("token-2");

    const remotes = await system.run(listCliRemoteConnections);
    expect(remotes).toHaveLength(1);
    expect(remotes[0]?.id).toBe(created.connection.id);

    await system.dispose();
  });

  it("removes remote connections by selector", async () => {
    const system = await createCliRemoteSystem();

    const created = await system.run(
      addCliRemoteConnection({
        wsUrl: "ws://127.0.0.1:9001/ws",
        authToken: "token",
        name: "Host A",
      }),
    );

    const removedByName = await system.run(
      removeCliRemoteConnection({
        selector: "Host A",
      }),
    );
    expect(removedByName.connection.id).toBe(created.connection.id);
    expect(await system.run(listCliRemoteConnections)).toHaveLength(0);

    await system.dispose();
  });

  it("matches relay-backed remote selectors by relay host metadata", async () => {
    const system = await createCliRemoteSystem();
    const relayDraft = buildRelayHostConnectionDraft({
      name: "Relay host",
      relayUrl: "wss://relay.example.com/v1/ws",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      sessionId: "session-1",
      secret: "secret-1",
    });

    const created = await system.run(
      addCliRemoteConnection({
        wsUrl: relayDraft.wsUrl,
        name: "Relay host",
      }),
    );

    const removed = await system.run(
      removeCliRemoteConnection({
        selector: "host-device-1",
      }),
    );
    expect(removed.connection.id).toBe(created.connection.id);
    expect(await system.run(listCliRemoteConnections)).toHaveLength(0);

    await system.dispose();
  });
});
