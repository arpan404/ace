import { expect, it } from "vitest";
import type { ServerMessage } from "@ace/protocol";
import { deviceKey, useAccountBackend } from "./machine-standing-test-support.ts";
import { helloWith, mia, orgTeamHost } from "./org-host-test-support.ts";

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
