import { expect, it } from "vitest";
import type { ServerMessage } from "@ace/protocol";
import { deviceKey, useAccountBackend } from "./machine-standing-test-support.ts";
import { Command } from "@ace/protocol";
import type { Client } from "./socket-test-support.ts";
import { helloWith, mia, orgTeamHost, provesMember } from "./org-host-test-support.ts";

// ADR 0209 §7.4 end to end: a real org host on ace's account backend (the Worker and D1 under
// Miniflare, against a fake WorkOS). Once the host's roster revokes a member, a member grant
// minted before the removal, still unexpired, opens nothing on the host, and the member's open
// socket closes at once rather than when its grant runs out.

const backend = useAccountBackend();

it("a member the roster revoked can't finish a hello on a grant still valid, and loses their socket", async () => {
  const { home, org, miaToken, memberGrant, api } = await orgTeamHost(backend);
  try {
    const key = await deviceKey();
    const grant = await memberGrant(miaToken, key.raw);
    expect(grant.status).toBe(200);
    await home.memberWork.sync();
    expect(home.memberWork.active(mia.id)).toBe(true);
    const open = await helloWith(home, grant.token);
    expect(open.refused).toBeUndefined();
    const closed = new Promise<number>((resolve) =>
      open.client.socket.once("close", (code: number) => resolve(code)),
    );

    // Pat removes Mia; the host's next roster says so.
    const removed = await api.call(
      home.session.token,
      "DELETE",
      `/v1/orgs/${org}/members/${mia.id}`,
    );
    expect(removed.status).toBe(200);
    await home.memberWork.sync();
    expect(home.memberWork.revoked(mia.id)).toBe(true);

    expect(await closed).toBe(4012);
    // The grant minted before the removal still verifies, but no hello finishes on it.
    const again = await helloWith(home, grant.token);
    expect(again.refused).toBe("unauthorized");
    const message: ServerMessage | undefined = await again.client.next().catch(() => undefined);
    expect(message?.type).not.toBe("welcome");
  } finally {
    await home.close();
  }
});

/** What the daemon answers `client`'s command `payload`: its result, or the refusal. */
async function commands(
  client: Client,
  id: string,
  payload: Command["payload"],
  deviceId = "phone",
) {
  client.send({
    type: "command",
    command: Command.parse({ id, deviceId, payload }),
  });
  for (;;) {
    const message: ServerMessage = await client.next();
    if (message.type === "commandResult" && message.commandId === id) return { ok: message.ok };
    if (message.type === "error") return { refused: message.code };
  }
}

it("until thread ownership is wired, a member can start or continue no work on an org host", async () => {
  // Production wiring: no owner resolver, nothing calls resume(). Mia proves her standing.
  const { home, miaToken, memberGrant } = await orgTeamHost(backend);
  try {
    const key = await deviceKey();
    const grant = await memberGrant(miaToken, key.raw);
    const admitted = await helloWith(home, grant.token);
    expect(admitted.refused).toBeUndefined();
    expect(
      (await provesMember(admitted.client, home.host, admitted.nonce, grant.token, key)).ok,
    ).toBe(true);
    // Neither a new tree, nor a message, answer or resume in one that exists.
    const thread = home.f.thread.id;
    const tries: [string, Command["payload"]][] = [
      [
        "start",
        {
          type: "thread.create",
          workspaceId: home.f.workspace,
          provider: "codex",
          input: [{ type: "text", text: "start" }],
        },
      ],
      ["send", { type: "thread.send", threadId: thread, input: [{ type: "text", text: "go" }] }],
      ["resume", { type: "queue.resume", threadId: thread, expectedRevision: 0 }],
    ];
    for (const [id, payload] of tries)
      expect(await commands(admitted.client, id, payload)).toEqual({ refused: "forbidden" });
    // Pat, the host's operator, still runs the host's own work.
    const page = await home.pageSocket();
    expect(
      await commands(
        page.client,
        "host-send",
        {
          type: "thread.send",
          threadId: thread,
          input: [{ type: "text", text: "host work" }],
        },
        "device",
      ),
    ).toMatchObject({ ok: expect.any(Boolean) });
  } finally {
    await home.close();
  }
});
