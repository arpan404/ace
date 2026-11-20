import { constants } from "node:os";
import { describe, expect, it } from "vitest";
import { childNice, lowerChildPriority, type ChildPriorityPort } from "./child-priority.ts";

function os(platform: NodeJS.Platform, options: { threads?: number[]; refuse?: number[] } = {}) {
  const set = new Map<number, number>();
  const port: ChildPriorityPort = {
    platform,
    setPriority(pid, priority) {
      if (options.refuse?.includes(pid)) throw new Error("ESRCH");
      set.set(pid, priority);
    },
    threads: () => options.threads ?? [],
  };
  return { port, set };
}

describe("the priority a child of the daemon runs at", () => {
  it.each([
    ["linux", 5],
    ["darwin", 5],
    ["freebsd", 5],
    ["win32", constants.priority.PRIORITY_BELOW_NORMAL],
    ["aix", undefined],
  ] as const)("%s: %s", (platform, nice) => {
    expect(childNice(platform)).toBe(nice);
  });

  it("lowers every thread a Linux child already started", () => {
    const { port, set } = os("linux", { threads: [100, 101, 102] });
    expect(lowerChildPriority(100, port)).toBe(true);
    expect([...set]).toEqual([
      [100, 5],
      [101, 5],
      [102, 5],
    ]);
  });

  it("lowers a macOS child as one process", () => {
    const { port, set } = os("darwin", { threads: [7, 8] });
    expect(lowerChildPriority(7, port)).toBe(true);
    expect([...set]).toEqual([[7, 5]]);
  });

  it("leaves a child that already exited as it was, without throwing", () => {
    const { port, set } = os("linux", { refuse: [100] });
    expect(lowerChildPriority(100, port)).toBe(false);
    expect(set.size).toBe(0);
  });

  it("changes nothing where it has no priority to give", () => {
    const { port, set } = os("aix");
    expect(lowerChildPriority(1, port)).toBe(false);
    expect(set.size).toBe(0);
  });
});
