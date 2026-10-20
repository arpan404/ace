import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Actor } from "./session-options.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

/*
 * Leaving a page with unsaved changes in ace's own Chrome (ADR 0067, "Leaving a page the
 * person was editing"). The person's input arrives the way a live viewer sends it.
 */
const agent: Actor = { kind: "agent", agentId: "agent" };
const person: Actor = { kind: "human", connectionId: "person" };
const quick = { quietMs: 200, maxWaitMs: 5_000, inUseMs: 8_000, followAfterMs: 1_000 };
const Pending = z.object({
  pending_dialog: z.object({ dialogId: z.string(), type: z.string() }),
});

/** A form that warns before it is left with unsaved text. */
async function form() {
  const f = await fixture({ collaboration: { ...quick, presentMs: 1_000 } });
  await f.navigate();
  const run = (expression: string) =>
    f.service.execute("thread", { action: "evaluate", expression }, agent);
  await run(
    `document.body.innerHTML = '<input aria-label="Note" id="note"><button>Save</button>';
     addEventListener('beforeunload', (event) => {
       if (document.getElementById('note').value) { event.preventDefault(); event.returnValue = ''; }
     });
     true`,
  );
  const snapshot = await f.service.execute("thread", { action: "snapshot" }, agent);
  const note = () => run("document.getElementById('note').value");
  return { f, snapshot, note, elsewhere: `${f.url}/data` };
}

describe.skipIf(!executablePath)("leaving a page with unsaved changes", () => {
  it("an agent's navigation away from the person's half-written note asks the person instead of discarding it", async () => {
    const { f, note, elsewhere } = await form();
    await f.service.execute(
      "thread",
      { action: "evaluate", expression: "document.getElementById('note').focus(); true" },
      person,
    );
    for (const key of ["h", "i"])
      await f.service.input("thread", { kind: "key", event: "char", key, text: key }, "person");
    await new Promise((resolve) => setTimeout(resolve, quick.quietMs + 100));

    const left = Pending.parse(
      await f.service.execute("thread", { action: "navigate", url: elsewhere }, agent),
    );
    expect(left.pending_dialog.type).toBe("beforeunload");
    // The agent may not agree to throw the person's note away.
    await expect(
      f.service.execute(
        "thread",
        { action: "dialog", dialogId: left.pending_dialog.dialogId, accept: true },
        agent,
      ),
    ).rejects.toMatchObject({ code: "unsaved_changes" });
    // The person chooses to stay: their note is still there.
    await f.service.execute(
      "thread",
      { action: "dialog", dialogId: left.pending_dialog.dialogId, accept: false },
      person,
    );
    expect(await note()).toBe("hi");
  }, 60_000);

  it("the person's own navigation right after an agent typed still asks them", async () => {
    const { f, snapshot, note, elsewhere } = await form();
    await f.service.execute("thread", { action: "click", ref: ref(snapshot, "Note") }, agent);
    await f.service.execute(
      "thread",
      { action: "type", ref: ref(snapshot, "Note"), text: "draft" },
      agent,
    );
    // Within the agent's in-use window, the person heads elsewhere from the address bar.
    const left = Pending.parse(
      await f.service.execute("thread", { action: "navigate", url: elsewhere }, person),
    );
    expect(left.pending_dialog.type).toBe("beforeunload");
    await f.service.execute(
      "thread",
      { action: "dialog", dialogId: left.pending_dialog.dialogId, accept: false },
      person,
    );
    expect(await note()).toBe("draft");
  }, 60_000);

  it("an agent leaves a page only it has written in without asking anyone", async () => {
    const { f, snapshot, elsewhere } = await form();
    await f.service.execute("thread", { action: "click", ref: ref(snapshot, "Note") }, agent);
    await f.service.execute(
      "thread",
      { action: "type", ref: ref(snapshot, "Note"), text: "draft" },
      agent,
    );
    await f.service.execute("thread", { action: "navigate", url: elsewhere }, agent);
    expect(f.service.state("thread").url).toBe(elsewhere);
  }, 60_000);
});
