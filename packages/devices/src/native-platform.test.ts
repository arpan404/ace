// SPDX-License-Identifier: Apache-2.0

/**
 * The dispatch itself (D3.1): with `ACE_DEVICE_PLATFORM=native` the facade asks the addon for
 * the plan, and an addon refusal becomes the `DeviceError` it names. No SDK command runs.
 */
import { expect, test, vi } from "vitest";

const addon = vi.hoisted(() => ({
  calls: [] as unknown[][],
  answer: '{"ok":true,"value":{"serveSim":true,"scrcpy":true,"timeoutMs":300000}}',
}));

vi.mock("./native-devices-addon.ts", () => {
  class Refused extends Error {
    readonly refusal: { code: string; message: string; hint: string };
    constructor(refusal: { code: string; message: string; hint: string }) {
      super(refusal.message);
      this.refusal = refusal;
    }
  }
  return {
    Refused,
    envStrings: (env: Record<string, string | undefined>) => env,
    nativeDevices: () => ({
      devicePlatformDownloadPlan: (...args: unknown[]) => {
        addon.calls.push(args);
        return addon.answer;
      },
    }),
    answered: (invoke: () => string) => {
      const answer = JSON.parse(invoke()) as {
        ok: boolean;
        value?: unknown;
        error?: { code: string; message: string; hint: string };
      };
      if (!answer.ok || answer.error) {
        if (!answer.error) throw new Error("refused without a word");
        throw new Refused(answer.error);
      }
      return answer.value;
    },
  };
});

const { NativeDevicePlatform } = await import("./native-platform.ts");
const { DeviceError } = await import("./sdk.ts");

function platform() {
  return new NativeDevicePlatform({ platform: "darwin", home: "/home/a", env: {} });
}

test("the native platform's tools plan is the addon's, with today's wants and budget", () => {
  addon.calls.length = 0;
  addon.answer = '{"ok":true,"value":{"serveSim":true,"scrcpy":true,"timeoutMs":300000}}';
  const plan = (
    platform() as unknown as {
      toolsPlan(): { serveSim: boolean; scrcpy: boolean; timeoutMs: number };
    }
  ).toolsPlan();
  expect(plan).toEqual({ serveSim: true, scrcpy: true, timeoutMs: 300_000 });
  expect(addon.calls).toEqual([["darwin", undefined, undefined]]);
});

test("an addon refusal is the DeviceError the platform raises", () => {
  addon.answer =
    '{"ok":false,"error":{"code":"tool_missing","message":"ace has nowhere to keep device tools","hint":"Restart ace; its home directory should hold them."}}';
  expect(() =>
    (
      platform() as unknown as {
        toolsPlan(): { serveSim: boolean; scrcpy: boolean; timeoutMs: number };
      }
    ).toolsPlan(),
  ).toThrow(DeviceError);
  expect(() =>
    (
      platform() as unknown as {
        toolsPlan(): { serveSim: boolean; scrcpy: boolean; timeoutMs: number };
      }
    ).toolsPlan(),
  ).toThrow("ace has nowhere to keep device tools");
  addon.answer = '{"ok":true,"value":{"serveSim":true,"scrcpy":true,"timeoutMs":300000}}';
});
