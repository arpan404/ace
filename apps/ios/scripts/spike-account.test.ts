import { describe, expect, it } from "vitest";
import { SpikeAccount, spikeAccountMachineIds, spikeAccountToken } from "./spike-account.ts";

const origin = "http://127.0.0.1:9841";
const call = (account: SpikeAccount, method: string, path: string, token = spikeAccountToken) =>
  account.handle(
    new Request(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}` } }),
  );
const json = async (reply: Response | undefined) => {
  expect(reply?.status).toBe(200);
  return reply?.json();
};
const requests = async (account: SpikeAccount) =>
  (await json(await account.handle(new Request(`${origin}/account/requests`)))).requests;

const send = (account: SpikeAccount, method: string, path: string, body?: unknown) =>
  account.handle(
    new Request(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${spikeAccountToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const acme = () => {
  process.env.ACE_IOS_SPIKE_ORG_HOSTS = "H".repeat(52);
  const account = new SpikeAccount(() => 0);
  delete process.env.ACE_IOS_SPIKE_ORG_HOSTS;
  return account;
};

describe("spike account backend", () => {
  it("answers the session and lists the account's machines", async () => {
    const account = new SpikeAccount(() => 1_000_000);
    expect((await json(await call(account, "GET", "/v1/account/session"))).account.email).toBe(
      "ada@example.com",
    );
    const listed = await json(await call(account, "GET", "/v1/machines"));
    expect(listed.machines.map((machine: { hostId: string }) => machine.hostId)).toEqual([
      spikeAccountMachineIds.laptop,
      spikeAccountMachineIds.studio,
    ]);
  });

  it("records nothing until the phone forgets, signs out or deletes the account", async () => {
    const account = new SpikeAccount(() => 0);
    await call(account, "GET", "/v1/account/session");
    await call(account, "GET", "/v1/machines");
    expect(await requests(account)).toEqual([]);
  });

  it("forgetting a machine records it once and takes it off the list", async () => {
    const account = new SpikeAccount(() => 0);
    await json(await call(account, "DELETE", `/v1/machines/${spikeAccountMachineIds.studio}`));
    expect(await requests(account)).toEqual([
      { kind: "forget", hostId: spikeAccountMachineIds.studio },
    ]);
    const listed = await json(await call(account, "GET", "/v1/machines"));
    expect(listed.machines.map((machine: { name: string }) => machine.name)).toEqual(["arpan-mbp"]);
  });

  it("signing out records it and ends the session", async () => {
    const account = new SpikeAccount(() => 0);
    await json(await call(account, "DELETE", "/v1/account/session"));
    expect(await requests(account)).toEqual([{ kind: "signOut" }]);
    expect((await call(account, "GET", "/v1/account/session"))?.status).toBe(401);
  });

  it("deleting the account records it and ends the session and its machines", async () => {
    const account = new SpikeAccount(() => 0);
    expect(await json(await call(account, "DELETE", "/v1/account"))).toEqual({ deleted: true });
    expect(await requests(account)).toEqual([{ kind: "delete" }]);
    expect((await call(account, "GET", "/v1/account/session"))?.status).toBe(401);
    expect((await call(account, "GET", "/v1/machines"))?.status).toBe(401);
  });

  it("refuses another token and records nothing for it", async () => {
    const account = new SpikeAccount(() => 0);
    expect((await call(account, "DELETE", "/v1/account/session", "stolen"))?.status).toBe(401);
    expect((await call(account, "DELETE", "/v1/account", "stolen"))?.status).toBe(401);
    expect(
      (await call(account, "DELETE", `/v1/machines/${spikeAccountMachineIds.studio}`, "stolen"))
        ?.status,
    ).toBe(401);
    expect(await requests(account)).toEqual([]);
  });

  it("reset brings back the session, both machines and an empty log", async () => {
    const account = new SpikeAccount(() => 0);
    await call(account, "DELETE", `/v1/machines/${spikeAccountMachineIds.laptop}`);
    await call(account, "DELETE", "/v1/account");
    await json(await account.handle(new Request(`${origin}/account/reset`, { method: "POST" })));
    expect(await requests(account)).toEqual([]);
    expect((await json(await call(account, "GET", "/v1/machines"))).machines).toHaveLength(2);
  });

  it("leaves every other path to the rest of the fixture", async () => {
    const account = new SpikeAccount(() => 0);
    expect(await account.handle(new Request(`${origin}/control`, { method: "POST" }))).toBe(
      undefined,
    );
  });

  describe("an organization's admin routes", () => {
    it("an admin's invitation, role change and removal show in the lists and the log", async () => {
      const account = acme();
      await json(
        await send(account, "POST", "/v1/orgs/org_acme/invitations", {
          email: "lee@acme.example",
          role: "admin",
        }),
      );
      await json(
        await send(account, "PATCH", "/v1/orgs/org_acme/members/acct_kai", { role: "admin" }),
      );
      await json(await send(account, "DELETE", "/v1/orgs/org_acme/members/acct_kai"));

      const invited = await json(await send(account, "GET", "/v1/orgs/org_acme/invitations"));
      expect(invited.invitations.map((each: { email: string }) => each.email)).toEqual([
        "lee@acme.example",
      ]);
      const listed = await json(await send(account, "GET", "/v1/orgs/org_acme/members"));
      expect(listed.members.map((each: { account: string }) => each.account)).toEqual([
        "acct_spike",
        "acct_dana",
        "acct_sam",
      ]);
      expect(await requests(account)).toEqual([
        { org: "org_acme", kind: "invite", email: "lee@acme.example", role: "admin" },
        { org: "org_acme", kind: "role", account: "acct_kai", role: "admin" },
        { org: "org_acme", kind: "remove", account: "acct_kai" },
      ]);
    });

    it("an admin can't make anyone an owner, nor change or remove an owner", async () => {
      const account = acme();
      const promote = await send(account, "PATCH", "/v1/orgs/org_acme/members/acct_spike", {
        role: "owner",
      });
      const demote = await send(account, "PATCH", "/v1/orgs/org_acme/members/acct_dana", {
        role: "member",
      });
      const remove = await send(account, "DELETE", "/v1/orgs/org_acme/members/acct_dana");

      for (const refused of [promote, demote, remove]) {
        expect(refused?.status).toBe(403);
        expect(await refused?.json()).toEqual({ error: "forbidden" });
      }
      expect(await requests(account)).toEqual([]);
    });

    it("an owner makes another owner, and then may remove the first", async () => {
      const account = new SpikeAccount(() => 0);
      const made = await json(await send(account, "POST", "/v1/orgs", { name: "Night Shift" }));
      const org = `/v1/orgs/${made.id}/members`;
      await json(await send(account, "PATCH", `${org}/acct_dana`, { role: "member" }));
      await json(await send(account, "PATCH", `${org}/acct_dana`, { role: "owner" }));
      await json(await send(account, "DELETE", `${org}/acct_dana`));

      const listed = await json(await send(account, "GET", org));
      expect(listed.members.map((each: { account: string }) => each.account)).toEqual([
        "acct_spike",
        "acct_kai",
        "acct_sam",
      ]);
      expect(await requests(account)).toEqual([
        { kind: "createOrg", name: "Night Shift" },
        { org: made.id, kind: "role", account: "acct_dana", role: "member" },
        { org: made.id, kind: "role", account: "acct_dana", role: "owner" },
        { org: made.id, kind: "remove", account: "acct_dana" },
      ]);
    });

    it("the last owner and a directory's member are refused with the backend's word", async () => {
      const account = new SpikeAccount(() => 0);
      const made = await json(await send(account, "POST", "/v1/orgs", { name: "Solo" }));
      const org = `/v1/orgs/${made.id}/members`;
      // Dana is the fixture's other owner; with her gone the person is the only one.
      await json(await send(account, "DELETE", `${org}/acct_dana`));
      const lastOwner = await send(account, "PATCH", `${org}/acct_spike`, { role: "admin" });
      const directory = await send(account, "PATCH", `${org}/acct_sam`, { role: "admin" });

      expect(lastOwner?.status).toBe(409);
      expect(await lastOwner?.json()).toEqual({ error: "last_owner" });
      expect(await directory?.json()).toEqual({ error: "directory_managed" });
    });

    it("a saved policy is the next version, and one made over an older version is refused", async () => {
      const account = acme();
      const policy = { effects: { pay: "off" } };
      const saved = await json(
        await send(account, "PUT", "/v1/orgs/org_acme/policy", { policy, version: 0 }),
      );
      const stale = await send(account, "PUT", "/v1/orgs/org_acme/policy", {
        policy: {},
        version: 0,
      });
      const read = await json(await send(account, "GET", "/v1/orgs/org_acme/policy"));

      expect(saved.version).toBe(1);
      expect(await stale?.json()).toEqual({ error: "policy_changed" });
      expect(read).toEqual({ org: "org_acme", version: 1, body: JSON.stringify(policy) });
    });
  });
});
