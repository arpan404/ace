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

    it("an invitation, a role change and a removal show in the lists and the log", async () => {
      const account = acme();
      await json(
        await send(account, "POST", "/v1/orgs/org_acme/invitations", {
          email: "lee@acme.example",
          role: "admin",
        }),
      );
      await json(
        await send(account, "PATCH", "/v1/orgs/org_acme/members/acct_spike", { role: "owner" }),
      );
      await json(await send(account, "DELETE", "/v1/orgs/org_acme/members/acct_dana"));

      const invited = await json(await send(account, "GET", "/v1/orgs/org_acme/invitations"));
      expect(invited.invitations.map((each: { email: string }) => each.email)).toEqual([
        "lee@acme.example",
      ]);
      const listed = await json(await send(account, "GET", "/v1/orgs/org_acme/members"));
      expect(listed.members.map((each: { account: string }) => each.account)).toEqual([
        "acct_spike",
        "acct_sam",
      ]);
      expect(await requests(account)).toEqual([
        { org: "org_acme", kind: "invite", email: "lee@acme.example", role: "admin" },
        { org: "org_acme", kind: "role", account: "acct_spike", role: "owner" },
        { org: "org_acme", kind: "remove", account: "acct_dana" },
      ]);
    });

    it("the last owner and a directory's member are refused with the backend's word", async () => {
      const account = acme();
      const lastOwner = await send(account, "DELETE", "/v1/orgs/org_acme/members/acct_dana");
      const directory = await send(account, "PATCH", "/v1/orgs/org_acme/members/acct_sam", {
        role: "admin",
      });

      expect(lastOwner?.status).toBe(409);
      expect(await lastOwner?.json()).toEqual({ error: "last_owner" });
      expect(await directory?.json()).toEqual({ error: "directory_managed" });
      expect(await requests(account)).toEqual([]);
    });

    it("a saved policy is the next version", async () => {
      const account = acme();
      const policy = { effects: { pay: "off" } };
      const saved = await json(await send(account, "PUT", "/v1/orgs/org_acme/policy", { policy }));
      const read = await json(await send(account, "GET", "/v1/orgs/org_acme/policy"));

      expect(saved.version).toBe(1);
      expect(read).toEqual({ org: "org_acme", version: 1, body: JSON.stringify(policy) });
    });
  });
});
