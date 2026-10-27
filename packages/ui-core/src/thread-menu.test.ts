import { describe, expect, it } from "vitest";
import type { ThreadStatus } from "@ace/protocol";
import {
  deleteQuestion,
  runningWork,
  stopAndDeleteQuestion,
  threadMenu,
  threadMenuLabels,
} from "./thread-menu.ts";

const done: ThreadStatus = { state: "done" };
const working: ThreadStatus = { state: "working", agents: 3 };
const flags = { settled: false, unread: false, pinned: false };

describe("thread menu", () => {
  it("offers settling only once the tree stops working, and unsettling once settled", () => {
    expect(threadMenu({ status: done }, flags)).toContain("settle");
    expect(threadMenu({ status: working }, flags)).not.toContain("settle");
    const settled = threadMenu({ status: working }, { ...flags, settled: true });
    expect(settled).toContain("unsettle");
    expect(settled).not.toContain("settle");
  });

  it("toggles read, pin and auto-settle by the thread's own state", () => {
    const fresh = threadMenu({ status: done }, flags);
    expect(fresh).toEqual(expect.arrayContaining(["unread", "pin", "auto-settle-off"]));
    const organised = threadMenu(
      { status: done, autoSettle: false },
      { ...flags, unread: true, pinned: true },
    );
    expect(organised).toEqual(expect.arrayContaining(["read", "unpin", "auto-settle-on"]));
    expect(organised).not.toContain("unread");
  });

  it("restores an archived thread instead of archiving it, and always ends with delete", () => {
    const listed = threadMenu({ status: done }, flags);
    const archived = threadMenu({ status: done, archivedAt: 5 }, flags);
    expect(listed).toContain("archive");
    expect(archived).toContain("restore");
    expect(archived).not.toContain("archive");
    expect(archived.at(-1)).toBe("delete");
    expect(threadMenuLabels.delete).toBe("Delete thread");
  });
});

describe("delete question", () => {
  it("deletes a finished thread plainly", () => {
    const question = deleteQuestion([{ title: "Fix login", status: done }]);
    expect(question).toMatchObject({ title: "Delete thread?", confirm: "Delete", force: false });
    expect(question.message).toBe("“Fix login” will be permanently deleted.");
  });

  it("stops running agents first and says how many", () => {
    const question = deleteQuestion([
      { title: "A", status: working },
      { title: "B", status: { state: "needs_you", interactions: 1 } },
      { title: "C", status: done },
    ]);
    expect(question).toMatchObject({ title: "Delete 3 threads?", confirm: "Stop and delete" });
    expect(question.force).toBe(true);
    expect(question.running).toBe("4 agents running. Running work will stop before deletion.");
  });
});

describe("stop and delete", () => {
  it("asks again to stop what still runs before deleting", () => {
    expect(stopAndDeleteQuestion(["Fix login"])).toMatchObject({
      title: "Delete thread?",
      confirm: "Stop and delete",
      force: true,
    });
    expect(stopAndDeleteQuestion(["A", "B"]).message).toMatch(/^2 threads will be permanently/);
  });
});

describe("running work", () => {
  it("names what keeps running before an archive hides it", () => {
    expect(runningWork({ status: done })).toBeUndefined();
    expect(runningWork({ status: { state: "needs_you", interactions: 1 } })).toBe(
      "It's waiting for you.",
    );
  });
});
