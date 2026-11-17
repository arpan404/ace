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

  it("records nothing until the phone forgets or signs out", async () => {
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

  it("refuses another token and records nothing for it", async () => {
    const account = new SpikeAccount(() => 0);
    expect((await call(account, "DELETE", "/v1/account/session", "stolen"))?.status).toBe(401);
    expect(
      (await call(account, "DELETE", `/v1/machines/${spikeAccountMachineIds.studio}`, "stolen"))
        ?.status,
    ).toBe(401);
    expect(await requests(account)).toEqual([]);
  });

  it("reset brings back the session, both machines and an empty log", async () => {
    const account = new SpikeAccount(() => 0);
    await call(account, "DELETE", `/v1/machines/${spikeAccountMachineIds.laptop}`);
    await call(account, "DELETE", "/v1/account/session");
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
});
