import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { hostSocket } from "./host-socket-test-support.ts";

/*
 * Through a real daemon (AGENTS.md: agents never answer approvals; ADR 0178 §12.5): a socket that
 * says it is an agent's device, as the CLI does in an agent's shell, can't answer a provider's
 * approval or change a setting; the person's own socket can. A process test because it is the
 * wiring of `answer-gate.ts` into the command path and the settings session.
 */

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

test("an agent's device can't answer a provider's approval; the person's device can", async () => {
  const f = await daemonFixture();
  cleanup.push(() => f.daemon.close());
  const home = join(f.h.home, "daemon");
  await f.h.emit(f.caller.threadId, {
    type: "interaction.opened",
    agent: "root",
    interaction: "permission",
    blocking: true,
    request: {
      kind: "approval",
      title: "Run the migration?",
      options: [
        { id: "yes", label: "Allow once", kind: "allow_once" },
        { id: "no", label: "Deny", kind: "deny" },
      ],
    },
  });
  await f.daemon.engine?.flush();
  const id = f.daemon.store.getThread(f.caller.threadId)?.live?.asking?.[0]?.id;
  if (!id) throw new Error("No pending approval");
  const yes = { kind: "approval", optionId: "yes" };
  for (const device of ["ace-agent", "ace-reviewer"]) {
    const agent = await hostSocket(home, device, cleanup);
    expect(await agent.answer(`by-${device}`, id, yes)).toMatchObject({
      ok: false,
      error: "human_answer_required",
    });
  }
  expect(f.daemon.store.getInteraction(id)?.state).toBe("pending");
  const person = await hostSocket(home, "ace-cli", cleanup);
  expect(await person.answer("by-person", id, yes)).toMatchObject({ ok: true });
});

test("an agent's device can't change settings; the person's device can", async () => {
  const f = await daemonFixture();
  cleanup.push(() => f.daemon.close());
  const home = join(f.h.home, "daemon");
  const agent = await hostSocket(home, "ace-agent", cleanup);
  expect(await agent.settings("agent-set", "beta.marketplace", true)).toMatchObject({
    ok: false,
  });
  expect((await f.daemon.settings.get("beta.marketplace")).value).toBe(false);
  const person = await hostSocket(home, "ace-cli", cleanup);
  expect(await person.settings("person-set", "beta.marketplace", true)).toMatchObject({
    ok: true,
  });
  expect((await f.daemon.settings.get("beta.marketplace")).value).toBe(true);
});
