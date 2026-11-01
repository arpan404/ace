import { HostId, ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { setup } from "./notify.test-helper.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function fixture(outcome: Parameters<typeof setup>[0] = "accepted") {
  const f = setup(outcome);
  fixtures.push(f);
  return f;
}
/** The fixture's thread, as a child an agent on a paired machine delegated here. */
const delegatedHere = (f: ReturnType<typeof setup>) =>
  f.append([
    {
      type: "thread.updated",
      delegatedFrom: { hostId: HostId.parse("host-a"), threadId: ThreadId.parse("parent-on-a") },
    },
  ]);
const askApproval = (f: ReturnType<typeof setup>) =>
  f.fact({
    type: "interaction.opened",
    agent: "root",
    interaction: "approval",
    blocking: true,
    request: {
      kind: "approval",
      title: "Run the tests",
      options: [
        { id: "yes", label: "Allow", kind: "allow_once" },
        { id: "no", label: "Deny", kind: "deny" },
      ],
    },
  });

it("a paired machine's child asking for approval alerts no device here; a local thread does", async () => {
  const local = fixture();
  local.start();
  askApproval(local);
  await local.flush();
  expect(local.deliveries.map((d) => d.notification.status)).toEqual(["needs_you", "needs_you"]);

  const delegated = fixture();
  delegatedHere(delegated);
  delegated.start();
  askApproval(delegated);
  delegated.end();
  await delegated.flush();
  delegated.service.notify({
    id: "agent-says",
    threadId: delegated.threadId,
    title: "Child says",
    status: "agent_says",
    backgroundCount: 0,
    actions: [],
  });
  await delegated.flush();
  expect(delegated.deliveries).toEqual([]);
  expect(delegated.service.feed(delegated.phone, 0).entries).toEqual([]);
});

it("alerts already queued for a thread are dropped once it is known as a paired machine's child", async () => {
  const local = fixture("retry");
  local.start();
  local.end();
  await local.flush();
  local.setOutcome("accepted");
  local.setTime(7000);
  await local.service.drain();
  expect(local.deliveries).toHaveLength(4);

  const delegated = fixture("retry");
  delegated.start();
  delegated.end();
  await delegated.flush();
  expect(delegated.deliveries).toHaveLength(2);
  delegatedHere(delegated);
  delegated.setOutcome("accepted");
  delegated.setTime(7000);
  await delegated.service.drain();
  expect(delegated.deliveries).toHaveLength(2);
});
