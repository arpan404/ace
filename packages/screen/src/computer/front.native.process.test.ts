/*
 * The real computer engine leaves the person's frontmost app in front while it launches
 * Calculator, presses its buttons and types into it. Opt-in: it operates Calculator on this Mac
 * (and nothing else) and needs Accessibility for the built helper.
 *   ACE_COMPUTER_LIVE=1 bun run test packages/screen/src/computer/front.native.process.test.ts
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { probeOutput } from "@ace/provider-kit/process";
import { ComputerClient } from "./client.ts";
import { ComputerActResult, ComputerHello, ComputerState } from "./wire.ts";

const directory = new URL("../../../../native/screen-helper/", import.meta.url).pathname;
const calculator = "com.apple.calculator";

/** The frontmost app as the window server reports it, read synchronously. */
function frontmost(): string {
  const asn = execFileSync("lsappinfo", ["front"]).toString().trim();
  return execFileSync("lsappinfo", ["info", "-only", "bundleid", asn]).toString().trim();
}
function calculatorRunning(): boolean {
  return (
    execFileSync("lsappinfo", ["find", `bundleid=${calculator}`])
      .toString()
      .trim() !== ""
  );
}

it.skipIf(process.platform !== "darwin" || process.env.ACE_COMPUTER_LIVE !== "1")(
  "launching, pressing and typing in Calculator never changes the frontmost app",
  { timeout: 180_000 },
  async (context) => {
    // Signing reads the person's keychain, so the build runs with their real home.
    const real = process.env.ACE_TEST_REAL_HOME;
    const build = await probeOutput("sh", [join(directory, "build.sh")], {
      timeoutMs: 120_000,
      ...(real ? { env: { HOME: real } } : {}),
    });
    expect(build.code, build.stderr).toBe(0);
    const helper = join(directory, "build/ace-screen-helper");
    const open = () => new ComputerClient({ helper: async () => helper, nextId: randomUUID });
    let client = open();
    onTestFinished(() => client.close());
    const hello = ComputerHello.parse(await client.request("hello", {}));
    if (!hello.accessibility) {
      context.skip("Accessibility has not been granted to the built helper");
      return;
    }
    const wasRunning = calculatorRunning();
    onTestFinished(() => {
      // Quitting by Apple event never activates; only a Calculator this test opened is closed.
      if (!wasRunning)
        execFileSync("osascript", ["-e", `tell application id "${calculator}" to quit`]);
    });

    const before = frontmost();
    if (before.includes(calculator)) {
      context.skip("Calculator is the frontmost app; the check needs another app in front");
      return;
    }
    const seen = new Set<string>();
    const sampler = setInterval(() => seen.add(frontmost()), 25);
    onTestFinished(() => clearInterval(sampler));

    let look = ComputerState.parse(await client.request("state", { app: calculator }));
    if (look.windows.length === 0) {
      // A window a fresh launch puts on another Space is found by a new helper.
      client.close();
      client = open();
      look = ComputerState.parse(await client.request("state", { app: calculator }));
    }
    expect(look.front).toBeUndefined();
    const seven = look.nodes.find((node) => node.role === "button" && node.name === "7");
    if (!seven) throw new Error("Calculator showed no 7 button");
    const acted = ComputerActResult.parse(
      await client.request("act", {
        app: calculator,
        actions: [
          { type: "key", key: "Escape" },
          { type: "type", text: "12+34=" },
          { type: "click", id: seven.id },
          { type: "key", key: "Escape" },
        ],
      }),
    );
    clearInterval(sampler);
    seen.add(frontmost());

    expect(acted.error).toBeUndefined();
    expect(acted.done).toHaveLength(4);
    expect(acted.done.join("\n")).not.toContain("brought itself to the front");
    expect([...seen]).toEqual([before]);
  },
);
