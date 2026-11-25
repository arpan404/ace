// SPDX-License-Identifier: Apache-2.0

/**
 * The input machines D3.2 wired to `ace-devices`, built through the shell they are part of. A
 * machine only answers when the addon does: with `ACE_DEVICE_PLATFORM_ADDON` pointing nowhere,
 * the first call throws, as `simulator-touch.process` does on the on leg.
 */
import { describe, expect, it } from "vitest";
import { devicePlatformBackend } from "@ace/provider-kit/native-switches";
import { DeviceMessageReader } from "./scrcpy-protocol.ts";
import { ScrcpyClipboard } from "./scrcpy-clipboard.ts";
import { HeldPointers } from "./scrcpy-input.ts";
import { simulatorActionInput, simulatorTree } from "./simulator-ax.ts";

const native = devicePlatformBackend() === "native";

describe.runIf(native)("the machines wired to ace-devices", () => {
  it("a clipboard read waits for the device's reply the Rust machine routes to it", async () => {
    const sent: string[] = [];
    const clipboard = new ScrcpyClipboard({
      send: (message) => sent.push(message.type),
      after: () => () => {},
    });
    const read = clipboard.read("agent");
    expect(sent).toEqual(["getClipboard"]);
    clipboard.received({ type: "clipboard", text: "from-rust" });
    await expect(read).resolves.toBe("from-rust");
  });

  it("a held pointer is lifted by the Rust machine where it was last seen", () => {
    const held = new HeldPointers();
    held.apply({ kind: "pointer", phase: "down", pointerId: 3, x: 5, y: 6 });
    expect(held.release()).toEqual([{ kind: "pointer", phase: "up", pointerId: 3, x: 5, y: 6 }]);
    expect(held.release()).toEqual([]);
  });

  it("a control message is split by the Rust reader", () => {
    const messages: unknown[] = [];
    const reader = new DeviceMessageReader((message) => messages.push(message));
    reader.push(Buffer.from([0, 0, 0, 0, 2, 104, 105]));
    expect(messages).toEqual([{ type: "clipboard", text: "hi" }]);
  });
});

it("a scroll of a value that is not an object on a Button is the target's refusal", () => {
  // Today's order on both legs: the action is refused before its value is read.
  const raw = [
    {
      type: "Button",
      AXLabel: "OK",
      frame: { x: 0, y: 0, width: 100, height: 50 },
      children: [],
    },
  ];
  const tree = simulatorTree(raw, { width: 402, height: 874 }, {});
  const node = tree.nodes[0];
  if (!node) throw new Error("No node");
  expect(() =>
    simulatorActionInput(node, { ref: node.ref, action: "scroll", value: "down" } as never),
  ).toThrow("does not support");
});
