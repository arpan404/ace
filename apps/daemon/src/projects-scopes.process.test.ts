import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, ProjectsRequest, SocketTicket, PairingResponse } from "@ace/protocol";
import { projectFixture, projectServer, until } from "./projects-test-support.ts";
import { accessRequest, redeemPairing } from "./client-access.ts";
import { loadIdentity } from "./tls-identity.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { token } from "./socket-test-support.ts";

test("paired read operate and admin devices need explicit projects scope for paths and project commands", async () => {
  const f = await projectFixture();
  const identity = loadIdentity(tlsFixtureHome());
  const server = await projectServer(f, {
    remote: { host: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, identity },
  });
  try {
    const path = join(f.root, "project");
    await mkdir(path);
    for (const scopes of [["read", "operate"], ["admin"], ["read", "projects"]]) {
      const pairing = PairingResponse.parse(
        await accessRequest(server.httpUrl, "/v1/pairings", {
          method: "POST",
          token,
          body: { scopes },
        }),
      );
      const credential = await redeemPairing(pairing.url, "Remote");
      if (!server.remoteUrl) throw new Error("Remote unavailable");
      const issued = SocketTicket.parse(
        await accessRequest(server.remoteUrl.replace("wss:", "https:"), "/v1/tickets", {
          method: "POST",
          token: credential.token,
          fingerprint: identity.fingerprint,
        }),
      );
      const client = await server.connect({
        deviceId: credential.device.id,
        ticket: issued.ticket,
      });
      client.send(
        ProjectsRequest.parse({
          type: "projects.request",
          requestId: "browse",
          operation: { op: "fs.browse", path },
        }),
      );
      expect(await until(client, (message) => message.type === "projects.result")).toMatchObject({
        result: scopes.includes("projects")
          ? { kind: "directories" }
          : { kind: "error", code: "forbidden" },
      });
      for (const operation of [
        { op: "fs.search", query: "project" },
        { op: "fs.complete", path: `${path}/` },
        { op: "workspace.clone.validate", url: "arpan404/ace" },
      ]) {
        client.send(
          ProjectsRequest.parse({ type: "projects.request", requestId: "picker-scope", operation }),
        );
        expect(await until(client, (message) => message.type === "projects.result")).toMatchObject({
          result: scopes.includes("projects")
            ? {
                kind:
                  operation.op === "fs.search"
                    ? "search"
                    : operation.op === "fs.complete"
                      ? "completion"
                      : "cloneUrl",
              }
            : { kind: "error", code: "forbidden" },
        });
      }
      client.send({
        type: "command",
        command: Command.parse({
          id: `add-${credential.device.id}`,
          deviceId: credential.device.id,
          payload: { type: "workspace.add", path },
        }),
      });
      const result = await until(
        client,
        (message) => message.type === "commandResult" || message.type === "error",
      );
      expect(result).toMatchObject(
        scopes.includes("projects")
          ? { type: "commandResult", ok: true }
          : { type: "error", code: "forbidden" },
      );
      if (!scopes.includes("projects")) expect(f.projects.catalog.recent(100)).toEqual([]);
    }
    const desktop = f.store.devices.create("Desktop", ["desktop"], 1000);
    if (!server.remoteUrl) throw new Error("Remote unavailable");
    await expect(
      accessRequest(server.remoteUrl.replace("wss:", "https:"), "/v1/tickets", {
        method: "POST",
        token: desktop.token,
        fingerprint: identity.fingerprint,
      }),
    ).rejects.toThrow(/Desktop credentials are local only|403/);
    const client = await server.connect({ deviceId: desktop.device.id, token: desktop.token });
    client.send(
      ProjectsRequest.parse({
        type: "projects.request",
        requestId: "home",
        operation: { op: "fs.home" },
      }),
    );
    expect(await until(client, (message) => message.type === "projects.result")).toMatchObject({
      result: { kind: "home", path: f.root },
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test("system folders remain denied even when the host configures the filesystem root", async () => {
  const f = await projectFixture({ roots: async () => ["/"] });
  try {
    expect(await f.command({ type: "workspace.add", path: "/" })).toMatchObject({
      ok: false,
      error: "system_directory",
    });
    expect(await f.command({ type: "workspace.add", path: "/etc" })).toMatchObject({
      ok: false,
      error: "system_directory",
    });
    expect(
      (await f.read({ op: "fs.browse", path: "/usr", limit: 10, showHidden: false })).result,
    ).toMatchObject({ kind: "error", code: "system_directory" });
  } finally {
    await f.close();
  }
});
