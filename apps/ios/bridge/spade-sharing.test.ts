import { expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";

/*
 * A shared bot's marks on the iPhone (ADR 0206 §2.3), over the real SDK and a fake Spade: on an
 * org host a shared bot's row says "Shared", and its request says who may answer; a personal
 * machine's bots say neither.
 */

type Agent = ReturnType<FakeSpadeApi["addAgent"]>;

function bindToAcme(fake: FakeSpadeApi) {
  fake.org.binding = {
    org: "org_acme",
    name: "Acme Robotics",
    host: "host_1",
    policy: 1,
    auditKey: "key",
  };
}

test("on an org host a shared bot's row says Shared in its organization, and its own bots don't", async () => {
  const { patches, spade } = await setUp((fake) => {
    bindToAcme(fake);
    const triage = fake.addAgent({ name: "Triage" });
    fake.addAgent({ name: "Notes" });
    fake.org.access.set(triage.id, {
      org: "org_acme",
      maker: "acct_dana",
      approvers: ["acct_dana"],
    });
  });
  spade.handle({ type: "spade.watch", on: true });

  const shared = (name: string) =>
    patches.state?.list.rows?.find((row) => row.name === name)?.shared;
  await until(() => shared("Triage") ?? undefined);

  expect(shared("Triage")).toBe("Shared in Acme Robotics");
  expect(shared("Notes")).toBeNull();
});

test("a personal machine's bots are never marked shared", async () => {
  const { api, patches, spade } = await setUp((fake) => {
    fake.addAgent({ name: "Notes" });
  });
  spade.handle({ type: "spade.watch", on: true });

  await until(() => api.sent("GET", "/v1/org").length > 0);
  const rows = await until(() => patches.state?.list.rows ?? undefined);

  expect(rows.map((row) => row.shared)).toEqual([null]);
});

test("a shared bot's request names who else may answer, by the names the phone sends", async () => {
  let bot = undefined as Agent | undefined;
  const { patches, spade } = await setUp((fake) => {
    bindToAcme(fake);
    bot = fake.addAgent({ name: "Triage" });
    fake.org.access.set(bot.id, {
      org: "org_acme",
      maker: "acct_dana",
      approvers: ["acct_me", "acct_dana"],
    });
    fake.ask(bot, "call-1", "shell", { command: "npm test" });
  });
  if (!bot) throw new Error("no bot");
  spade.handle({
    type: "spade.people",
    people: { self: "acct_me", names: { acct_dana: "Dana Kim" } },
  });
  spade.handle({ type: "spade.open", conversationId: bot.conversation });

  const card = await until(() =>
    patches.bubbles.find((row) => row.kind === "ask" && row.approvers !== null),
  );

  expect(card).toMatchObject({
    approvers: "You or Dana Kim can answer. The first answer counts.",
  });
});

test("a request from a shared bot the person can't answer says who it waits on", async () => {
  let bot = undefined as Agent | undefined;
  const { patches, spade } = await setUp((fake) => {
    bindToAcme(fake);
    bot = fake.addAgent({ name: "Triage" });
    fake.org.access.set(bot.id, { org: "org_acme", maker: "acct_dana", approvers: ["acct_dana"] });
    fake.ask(bot, "call-1", "shell", { command: "npm test" });
  });
  if (!bot) throw new Error("no bot");
  spade.handle({ type: "spade.people", people: { self: "acct_me", names: {} } });
  spade.handle({ type: "spade.open", conversationId: bot.conversation });

  const card = await until(() =>
    patches.bubbles.find((row) => row.kind === "ask" && row.approvers !== null),
  );

  expect(card).toMatchObject({
    approvers: "Waiting on a member. Only its approvers can answer.",
  });
});
