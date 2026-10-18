import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { UnloadGuard, type UnloadContents } from "./unload.ts";

/** A native view whose page warns before it is left, and what each leave attempt came to. */
function view(facts: { agentDriving: boolean; personLeaving: boolean }, personSays = false) {
  const events = new EventEmitter();
  const contents: UnloadContents = {
    on: (event: string, listener: Parameters<EventEmitter["on"]>[1]) => events.on(event, listener),
  };
  const asked: string[] = [];
  let refusals = 0;
  const guard = new UnloadGuard(
    contents,
    () => facts,
    () => {
      asked.push("asked");
      return personSays;
    },
    () => refusals++,
  );
  /** The page asks to stay; true when the view leaves anyway. */
  const leave = () => {
    let left = false;
    events.emit("will-prevent-unload", { preventDefault: () => (left = true) });
    return left;
  };
  const navigated = () => events.emit("did-navigate", {}, "https://example.test/next", 200);
  return { guard, leave, navigated, asked, refusals: () => refusals };
}

it("an agent leaves a page only it used without anyone being asked", () => {
  const page = view({ agentDriving: true, personLeaving: false });
  expect(page.leave()).toBe(true);
  expect(page.asked).toEqual([]);
});

it("an agent's navigation keeps a page the person typed in, and says so at once", () => {
  const page = view({ agentDriving: true, personLeaving: false });
  page.guard.personUsed();
  expect(page.leave()).toBe(false);
  expect(page.asked).toEqual([]);
  expect(page.refusals()).toBe(1);
});

it("the person leaving their own page is asked, and staying keeps it", () => {
  const staying = view({ agentDriving: true, personLeaving: true }, false);
  staying.guard.personUsed();
  expect(staying.leave()).toBe(false);
  expect(staying.asked).toEqual(["asked"]);
  expect(staying.refusals()).toBe(0);
  const leaving = view({ agentDriving: false, personLeaving: false }, true);
  expect(leaving.leave()).toBe(true);
  expect(leaving.asked).toEqual(["asked"]);
});

it("a new page forgets that the person used the one before", () => {
  const page = view({ agentDriving: true, personLeaving: false });
  page.guard.personUsed();
  page.navigated();
  expect(page.leave()).toBe(true);
});
