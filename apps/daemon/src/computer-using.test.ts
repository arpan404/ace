import { ThreadId } from "@ace/protocol";
import { expect, it } from "vitest";
import { ComputerUsingThreads, type ThreadApps } from "./computer-using.ts";

function clock() {
  let now = 0;
  const timers: { due: number; run: () => void; live: boolean }[] = [];
  return {
    after(ms: number, run: () => void) {
      const timer = { due: now + ms, run, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    elapse(ms: number) {
      now += ms;
      for (const timer of timers.splice(0))
        if (timer.live && timer.due <= now) timer.run();
        else if (timer.live) timers.push(timer);
    },
  };
}

const thread = ThreadId.parse("thread-a");
const other = ThreadId.parse("thread-b");

it("an app stays listed across an agent's back-to-back calls and leaves a while after the last", () => {
  const time = clock();
  const using = new ComputerUsingThreads({ after: time.after, lingerMs: 5_000 });
  const heard: (readonly ThreadApps[])[] = [];
  using.subscribe((threads) => heard.push(threads));

  const look = using.begin(thread, "Calculator");
  expect(using.threads()).toEqual([{ threadId: thread, apps: ["Calculator"] }]);
  look();
  time.elapse(3_000);
  // The next step starts before the linger runs out: no flicker, nothing new to hear.
  const act = using.begin(thread, "Calculator");
  act();
  time.elapse(4_999);
  expect(using.threads()).toEqual([{ threadId: thread, apps: ["Calculator"] }]);
  time.elapse(1);
  expect(using.threads()).toEqual([]);
  expect(heard).toEqual([[{ threadId: thread, apps: ["Calculator"] }], []]);
});

it("each thread lists its own apps, and a call still running keeps its app", () => {
  const time = clock();
  const using = new ComputerUsingThreads({ after: time.after, lingerMs: 1_000 });
  const slow = using.begin(thread, "Mail");
  const quick = using.begin(thread, "Mail");
  using.begin(other, "Notes")();
  quick();
  quick();
  time.elapse(10_000);
  expect(using.threads()).toEqual([{ threadId: thread, apps: ["Mail"] }]);
  slow();
  time.elapse(1_000);
  expect(using.threads()).toEqual([]);
});
