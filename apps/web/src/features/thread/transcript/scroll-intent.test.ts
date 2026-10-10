import { expect, test } from "vitest";
import { listenScrollIntent } from "./scroll-intent.ts";

test("a tiny upward wheel step releases the live end before the next scroll event", () => {
  const element = document.createElement("div");
  const directions: boolean[] = [];
  listenScrollIntent(
    element,
    (up) => directions.push(up),
    () => {},
  );
  element.dispatchEvent(new WheelEvent("wheel", { deltaY: -0.1 }));
  element.dispatchEvent(new WheelEvent("wheel", { deltaY: 2 }));
  expect(directions).toEqual([true, false]);
});

test("a downward touch releases the live end and upward movement allows following again", () => {
  const element = document.createElement("div");
  const directions: boolean[] = [];
  listenScrollIntent(
    element,
    (up) => directions.push(up),
    () => {},
  );
  const touch = (type: string, y: number) => {
    const event = new Event(type);
    Object.defineProperty(event, "touches", { value: [{ clientY: y }] });
    element.dispatchEvent(event);
  };
  touch("touchstart", 100);
  touch("touchmove", 101);
  touch("touchmove", 90);
  expect(directions).toEqual([true, false]);
});

test("a pointer press stops jump re-aiming and detached listeners stop receiving input", () => {
  const element = document.createElement("div");
  let landing = "aiming";
  const detach = listenScrollIntent(
    element,
    () => {},
    () => {
      landing = "stopped";
    },
  );
  element.dispatchEvent(new Event("pointerdown"));
  expect(landing).toBe("stopped");
  detach();
  landing = "aiming";
  element.dispatchEvent(new Event("pointerdown"));
  expect(landing).toBe("aiming");
});
