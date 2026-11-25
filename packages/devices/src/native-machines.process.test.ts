// SPDX-License-Identifier: Apache-2.0

/**
 * The input machines D3.2 wired to `ace-devices`, built through the shell they are part of. A
 * machine only answers when the addon does: with `ACE_DEVICE_PLATFORM_ADDON` pointing nowhere,
 * the first call throws, as `simulator-touch.process` does on the on leg.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devicePlatformBackend } from "@ace/provider-kit/native-switches";
import { nativeCalls } from "./native-input.ts";
import { DeviceMessageReader } from "./scrcpy-protocol.ts";
import { ScrcpyClipboard } from "./scrcpy-clipboard.ts";
import { HeldPointers } from "./scrcpy-input.ts";
import { simulatorActionInput, simulatorTree } from "./simulator-ax.ts";

const native = devicePlatformBackend() === "native";

describe.runIf(native)("the machines wired to ace-devices", () => {
  it("a clipboard read waits for the device's reply the Rust machine routes to it", async () => {
    const before = nativeCalls();
    const sent: string[] = [];
    const clipboard = new ScrcpyClipboard({
      send: (message) => sent.push(message.type),
      after: () => () => {},
    });
    const read = clipboard.read("agent");
    expect(sent).toEqual(["getClipboard"]);
    clipboard.received({ type: "clipboard", text: "from-rust" });
    await expect(read).resolves.toBe("from-rust");
    // The answer came from the addon: the TypeScript machine never touches it.
    expect(nativeCalls()).toBeGreaterThan(before);
  });

  it("a read after an idle stretch waits its own reply window, not the next timer's", async () => {
    let now = 0;
    let timers: { at: number; run(): void }[] = [];
    const advance = async (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= end).toSorted((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        now = due.at;
        due.run();
        await Promise.resolve();
      }
      now = end;
    };
    const clipboard = new ScrcpyClipboard({
      send: () => {},
      after(ms, run) {
        const timer = { at: now + ms, run };
        timers.push(timer);
        return () => {
          timers = timers.filter((each) => each !== timer);
        };
      },
    });
    // A write whose acknowledgement never comes, then four idle seconds, then a read.
    void clipboard.write("hi", false).catch(() => {});
    await advance(4_000);
    let settled = false;
    const read = clipboard.read("agent").then((text) => {
      settled = true;
      return text;
    });
    // The write's deadline fires at five seconds; the read is one second old.
    await advance(1_000);
    expect(settled).toBe(false);
    await advance(500);
    await expect(read).resolves.toBe("");
  });

  it("a deferred read whose request cannot be sent rejects with that error", async () => {
    let now = 0;
    let timers: { at: number; run(): void }[] = [];
    const advance = async (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= end).toSorted((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        now = due.at;
        due.run();
        await Promise.resolve();
      }
      now = end;
    };
    let refuse = false;
    const clipboard = new ScrcpyClipboard({
      send(message) {
        if (refuse && message.type === "getClipboard") throw new Error("socket gone");
      },
      after(ms, run) {
        const timer = { at: now + ms, run };
        timers.push(timer);
        return () => {
          timers = timers.filter((each) => each !== timer);
        };
      },
    });
    // The person's read is not answered; its request holds another owner's read back until it
    // settles. That deferred read's send then throws: it must reject, not resolve empty.
    const person = clipboard.read("person");
    await advance(1_500);
    await expect(person).resolves.toBe("");
    const agent = clipboard.read("agent");
    refuse = true;
    await advance(8_500);
    await expect(agent).rejects.toThrow("socket gone");
  });

  it("a held pointer is lifted by the Rust machine where it was last seen", () => {
    const before = nativeCalls();
    const held = new HeldPointers();
    held.apply({ kind: "pointer", phase: "down", pointerId: 3, x: 5, y: 6 });
    expect(held.release()).toEqual([{ kind: "pointer", phase: "up", pointerId: 3, x: 5, y: 6 }]);
    expect(held.release()).toEqual([]);
    expect(nativeCalls()).toBeGreaterThan(before);
  });

  it("a control message is split by the Rust reader", () => {
    const before = nativeCalls();
    const messages: unknown[] = [];
    const reader = new DeviceMessageReader((message) => messages.push(message));
    reader.push(Buffer.from([0, 0, 0, 0, 2, 104, 105]));
    expect(messages).toEqual([{ type: "clipboard", text: "hi" }]);
    expect(nativeCalls()).toBeGreaterThan(before);
  });

  it("the machines cannot load with the addon missing, as the proof files cannot", () => {
    const directory = mkdtempSync(join(tmpdir(), "ace-native-missing-"));
    const script = join(directory, "child.mjs");
    writeFileSync(
      script,
      `const { nativeDevices } = await import(process.env.ACE_ADDON_MODULE);
try {
  nativeDevices();
} catch (error) {
  console.error(error.message);
  process.exit(3);
}
process.exit(0);
`,
    );
    const child = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        ACE_ADDON_MODULE: new URL("./native-devices-addon.ts", import.meta.url).href,
        ACE_DEVICE_PLATFORM_ADDON: join(directory, "missing.dylib"),
      },
      encoding: "utf8",
    });
    rmSync(directory, { recursive: true, force: true });
    expect(child.status).toBe(3);
    expect(child.stderr).toContain("needs the devices addon");
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
