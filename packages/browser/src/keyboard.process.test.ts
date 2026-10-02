import { describe, expect, it } from "vitest";
import { executablePath, fixture, ref } from "./test-support.ts";

describe.skipIf(!executablePath)("human numpad input", () => {
  it("edits with numpad navigation and inserts arithmetic keys at keypad location", async () => {
    const f = await fixture();
    await f.navigate();
    await f.execute({
      action: "type",
      ref: ref(await f.execute({ action: "snapshot" }), "Name"),
      text: "abc",
    });
    await f.evaluate(
      "window.keys=[];document.querySelector('input').addEventListener('keydown',e=>keys.push({key:e.key,code:e.code,location:e.location}))",
    );
    f.service.takeover("thread", "owner");
    const evaluate = (expression: string) =>
      f.service.execute(
        "thread",
        { action: "evaluate", expression },
        { kind: "human", connectionId: "owner" },
      );
    const press = async (key: string, code = key) => {
      for (const event of ["keyDown", "keyUp"])
        await f.service.input("thread", { kind: "key", event, key, code }, "owner");
    };
    await press("End", "Numpad1");
    await press("Backspace");
    expect(await evaluate("document.querySelector('input').value")).toBe("ab");
    await press("Home", "Numpad7");
    await press("Delete", "NumpadDecimal");
    expect(await evaluate("document.querySelector('input').value")).toBe("b");
    await press("End", "Numpad1");
    for (const [key, code] of [
      ["1", "Numpad1"],
      ["+", "NumpadAdd"],
      ["*", "NumpadMultiply"],
      ["-", "NumpadSubtract"],
      ["/", "NumpadDivide"],
      [".", "NumpadDecimal"],
    ]) {
      if (!key || !code) throw new Error("Missing keypad fixture");
      await press(key, code);
    }
    expect(await evaluate("document.querySelector('input').value")).toBe("b1+*-/.");
    expect(await evaluate("keys")).toEqual(
      expect.arrayContaining([
        { key: "End", code: "Numpad1", location: 3 },
        { key: "+", code: "NumpadAdd", location: 3 },
      ]),
    );
    expect(
      await evaluate("keys.filter(e=>e.code.startsWith('Numpad')).every(e=>e.location===3)"),
    ).toBe(true);
    await expect(
      f.service.input(
        "thread",
        { kind: "key", event: "keyDown", key: "+", code: "NumpadSubtract" },
        "owner",
      ),
    ).rejects.toThrow("key/code mismatch");
    expect(await evaluate("document.querySelector('input').value")).toBe("b1+*-/.");
  }, 60_000);
});
