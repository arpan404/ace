import { describe, expect, it } from "vitest";
import { executablePath, fixture, ref } from "./test-support.ts";
import { keepAgentsOut } from "./collaboration-test-support.ts";

describe.skipIf(!executablePath)("live Chromium shared by people and agents", () => {
  it("the person and an agent type into the same page without handing control around", async () => {
    const f = await fixture();
    await f.navigate();
    const name = ref(await f.execute({ action: "snapshot" }), "Name");
    await f.service.execute(
      "thread",
      { action: "type", ref: name, text: "human" },
      { kind: "human", connectionId: "owner" },
    );
    await f.service.input("thread", { kind: "key", event: "char", key: "!", text: "!" }, "other");
    expect(await f.evaluate("document.querySelector('input').value")).toBe("human!");
    // The person is still working here: the agent's text goes after theirs.
    await f.execute({ action: "type", ref: name, text: "returned" });
    expect(await f.evaluate("document.querySelector('input').value")).toBe("human!returned");
    await f.service.closeThread("thread");
  }, 60_000);

  it("rejects queued agent input when the person keeps agents out before dispatch", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<boolean>();
    const { promise: seen, resolve: entered } = Promise.withResolvers<void>();
    const f = await fixture({
      evaluatePolicy: () => {
        entered();
        return gate;
      },
    });
    await f.navigate();
    const name = ref(await f.execute({ action: "snapshot" }), "Name");
    const active = f.evaluate("1");
    const activeFailure = expect(active).rejects.toMatchObject({ code: "human_private" });
    await seen;
    const queued = f.execute({ action: "type", ref: name, text: "queued" });
    const queuedFailure = expect(queued).rejects.toMatchObject({ code: "human_private" });
    keepAgentsOut(f.service);
    release(true);
    await activeFailure;
    await queuedFailure;
    keepAgentsOut(f.service, "thread", false);
    expect(await f.evaluate("document.querySelector('input').value")).toBe("");
  }, 60_000);
});
