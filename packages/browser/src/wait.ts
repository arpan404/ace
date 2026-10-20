import { nextProbeDelay, textCondition } from "./text-condition.ts";
import { z } from "zod";
import type { BrowserBackendPage } from "./backend.ts";
import { NavigationTask, type NavigationClock } from "./navigation.ts";
import { BrowserActionError } from "./action-error.ts";
import { networkIdle, pause } from "./load-wait.ts";
import { urlCondition } from "./url-pattern.ts";

const Result = z.object({
  result: z.object({
    value: z
      .union([z.boolean(), z.object({ matched: z.boolean(), elapsed: z.number().nonnegative() })])
      .optional(),
  }),
  exceptionDetails: z.unknown().optional(),
});
/** Poll current facts, not a past event. A committed navigation may replace the context. */
async function waitForPage(
  page: BrowserBackendPage,
  expression: string | undefined,
  signal: AbortSignal,
  clock: NavigationClock,
  checkNavigation: () => void,
  element: (() => Promise<boolean>) | undefined,
): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    checkNavigation();
    let delay = 50;
    try {
      if (element) {
        if (await element()) return;
      } else {
        const response = Result.parse(
          await page.cdp.send("Runtime.evaluate", { expression, returnByValue: true }),
        );
        if (response.exceptionDetails) throw new BrowserActionError("invalid_data");
        const value = response.result.value;
        if (value === true || (typeof value === "object" && value.matched)) return;
        if (typeof value === "object") delay = nextProbeDelay(value.elapsed);
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(
          error.message,
        )
      )
        throw error;
    }
    await pause(clock, delay, signal);
  }
}

type WaitCommand = Extract<import("@ace/protocol").BrowserCommand, { action: "wait_for" }>;
function exactlyOne(): BrowserActionError {
  return new BrowserActionError("invalid_arguments", undefined, undefined, [
    {
      path: "url",
      expected:
        'exactly one wait condition: {url}, {text}, {ref, state: "visible" or "hidden"}, {networkIdle: true} or {timeMs}',
    },
  ]);
}

export async function waitForBrowser(options: {
  command: WaitCommand;
  page: BrowserBackendPage;
  refs: import("./refs.ts").SnapshotRefs;
  clock: NavigationClock;
  policies: import("./policy-waits.ts").NavigationPolicies;
  human: boolean;
  signal: AbortSignal | undefined;
  currentUrl(): string;
  checkNavigation(): void;
}) {
  const { command } = options;
  const choices = [
    command.ref,
    command.url,
    command.text,
    command.networkIdle,
    command.timeMs,
  ].filter((value) => value !== undefined).length;
  if (
    choices !== 1 ||
    (command.ref !== undefined ? command.state === undefined : command.state !== undefined)
  )
    throw exactlyOne();
  const { ref, state } = command;
  const element =
    ref !== undefined && state !== undefined
      ? () => options.refs.visible(ref).then((visible) => visible === (state === "visible"))
      : undefined;
  // A fixed pause gets its whole length, whatever the default timeout.
  const budget =
    command.timeMs === undefined
      ? command.timeout
      : Math.max(command.timeout, command.timeMs + 5_000);
  const task = new NavigationTask(options.human, budget, options.clock, options.signal);
  options.policies.start(task);
  try {
    options.checkNavigation();
    await task.run(async () => {
      if (command.timeMs !== undefined) return pause(options.clock, command.timeMs, task.signal);
      if (command.networkIdle) return networkIdle(options.page, options.clock, task.signal);
      const expression = element
        ? undefined
        : command.url !== undefined
          ? urlCondition(command.url)
          : textCondition(command.text ?? "");
      return waitForPage(
        options.page,
        expression,
        task.signal,
        options.clock,
        options.checkNavigation,
        element,
      );
    });
    options.checkNavigation();
    return { ok: true, url: options.currentUrl() };
  } finally {
    task.close();
    options.policies.finish(task);
  }
}
