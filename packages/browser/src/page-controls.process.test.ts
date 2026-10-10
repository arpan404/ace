import { expect, it } from "vitest";
import { setup, executablePath } from "./parity-test-support.ts";
import { ref } from "./test-support.ts";

it.skipIf(!executablePath)(
  "a fixture load wait keeps document refs stable when iframe responses arrive after the URL wait",
  async () => {
    let frameResponse = Promise.resolve();
    const frameReleased = Promise.withResolvers<void>();
    const f = await setup({}, () => frameResponse);
    frameResponse = frameReleased.promise;
    try {
      await f.execute({ action: "navigate", url: f.url + "/other" });
      await f.execute({ action: "wait_for", url: f.url + "/other" });
      expect(await f.evaluate("document.readyState")).toBe("interactive");
      frameReleased.resolve();
      await f.execute({ action: "wait_for", text: "Fixture ready" });
      const name = ref(await f.execute({ action: "snapshot" }), "Name");
      await f.execute({ action: "type", ref: name, text: "after frame load" });
      expect(await f.evaluate("document.querySelector('input').value")).toBe("after frame load");
    } finally {
      frameReleased.resolve();
    }
  },
  60000,
);

it.skipIf(!executablePath)(
  "history restores the document and its form, forward returns to the next page, reload refreshes it",
  async () => {
    const f = await setup();
    await f.execute({
      action: "type",
      ref: ref(await f.execute({ action: "snapshot" }), "Name"),
      text: "retained form",
    });
    await f.execute({ action: "navigate", url: f.url + "/other" });
    expect(await f.execute({ action: "navigation_history" })).toEqual({
      back: true,
      forward: false,
    });
    await f.execute({ action: "history", direction: "back" });
    await f.execute({ action: "wait_for", url: f.url + "/" });
    await f.execute({ action: "wait_for", text: "Fixture ready" });
    expect(await f.evaluate("document.querySelector('input').value")).toBe("retained form");
    expect(await f.execute({ action: "navigation_history" })).toEqual({
      back: true,
      forward: true,
    });
    await f.execute({ action: "history", direction: "forward" });
    await f.execute({ action: "wait_for", url: f.url + "/other" });
    await f.execute({ action: "wait_for", text: "Fixture ready" });
    await f.execute({
      action: "type",
      ref: ref(await f.execute({ action: "snapshot" }), "Name"),
      text: "before reload",
    });
    await f.execute({ action: "history", direction: "reload" });
    await expect
      .poll(() => f.evaluate("document.querySelector('input')?.value"), { timeout: 15000 })
      .toBe("");
  },
  60000,
);
it.skipIf(!executablePath)(
  "find in page selects visible text and clears selection",
  async () => {
    const f = await setup();
    expect(await f.execute({ action: "find_text", text: "Fixture ready" })).toEqual({
      found: true,
    });
    expect(await f.evaluate("getSelection().toString()")).toBe("Fixture ready");
    expect(await f.execute({ action: "find_text", text: "nonexistent fixture" })).toEqual({
      found: false,
    });
    await f.execute({ action: "find_text", text: "" });
    expect(await f.evaluate("getSelection().toString()")).toBe("");
  },
  60000,
);
it.skipIf(!executablePath)(
  "human key releases preserve editing and Meta select-all replaces a form value",
  async () => {
    const f = await setup();
    await f.execute({ action: "focus", ref: ref(await f.execute({ action: "snapshot" }), "Name") });
    f.service.takeover("thread", "viewer");
    for (const key of "abc") {
      await f.service.input(
        "thread",
        {
          kind: "key",
          event: "keyDown",
          key,
          code: `Key${key.toUpperCase()}`,
          modifiers: 0,
          text: key,
        },
        "viewer",
      );
      await f.service.input(
        "thread",
        { kind: "key", event: "keyUp", key, code: `Key${key.toUpperCase()}`, modifiers: 0 },
        "viewer",
      );
    }
    await f.service.input(
      "thread",
      { kind: "key", event: "keyDown", key: "a", code: "KeyA", modifiers: 4 },
      "viewer",
    );
    await f.service.input(
      "thread",
      { kind: "key", event: "keyUp", key: "a", code: "KeyA", modifiers: 4 },
      "viewer",
    );
    await f.service.input(
      "thread",
      { kind: "key", event: "char", key: "x", text: "x", modifiers: 0 },
      "viewer",
    );
    expect(
      await f.service.execute(
        "thread",
        { action: "evaluate", expression: "document.querySelector('input').value" },
        { kind: "human", connectionId: "viewer" },
      ),
    ).toBe("x");
  },
  60000,
);
it.skipIf(!executablePath)(
  "the person stops an existing recording after going private while agents and new recordings stay blocked",
  async () => {
    const f = await setup();
    await f.service.startRecording("thread");
    f.service.takeover("thread", "viewer", "private");
    await expect(f.service.stopRecording("thread")).rejects.toMatchObject({
      code: "human_private",
    });
    const artifact = await f.service.stopRecording("thread", {
      kind: "human",
      connectionId: "viewer",
    });
    expect(artifact.bytes).toBeGreaterThan(0);
    expect(f.artifacts).toContainEqual(artifact);
    await expect(f.service.startRecording("thread")).rejects.toMatchObject({
      code: "human_private",
    });
  },
  60000,
);
