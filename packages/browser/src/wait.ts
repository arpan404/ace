import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { NavigationTask, type NavigationClock } from "./navigation.ts";
import { BrowserActionError } from "./action-error.ts";

const Result = z.object({
  result: z.object({ value: z.boolean().optional() }),
  exceptionDetails: z.unknown().optional(),
});
/** Poll current facts, not a past event. A committed navigation may replace the context. */
async function waitForPage(
  cdp: BrowserCdp,
  condition: { url?: string | undefined; text?: string | undefined },
  signal: AbortSignal,
  clock: NavigationClock,
  checkNavigation: () => void,
  element: (() => Promise<boolean>) | undefined,
): Promise<void> {
  const expression =
    condition.url !== undefined
      ? `location.href === ${JSON.stringify(condition.url)} && document.readyState !== 'loading'`
      : `document.readyState !== 'loading' && (document.body?.innerText ?? '').includes(${JSON.stringify(condition.text)})`;
  while (true) {
    signal.throwIfAborted();
    checkNavigation();
    try {
      if (element) {
        if (await element()) return;
      } else {
        const response = Result.parse(
          await cdp.send("Runtime.evaluate", { expression, returnByValue: true }),
        );
        if (response.exceptionDetails) throw new Error("Browser page condition could not be read");
        if (response.result.value === true) return;
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
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        cancel();
        reject(signal.reason);
      };
      const cancel = clock.set(50, () => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

export async function waitForBrowser(options: {
  command: Extract<import("@ace/protocol").BrowserCommand, { action: "wait_for" }>;
  cdp: BrowserCdp;
  refs: import("./refs.ts").SnapshotRefs;
  clock: NavigationClock;
  policies: import("./policy-waits.ts").NavigationPolicies;
  human: boolean;
  signal: AbortSignal | undefined;
  currentUrl(): string;
  checkNavigation(): void;
}) {
  const { command } = options;
  const choices = [command.ref, command.url, command.text].filter(
    (value) => value !== undefined,
  ).length;
  if (
    choices !== 1 ||
    (command.ref !== undefined ? command.state === undefined : command.state !== undefined)
  )
    throw new BrowserActionError(
      "invalid_arguments",
      "Choose exactly one of url, text, or ref with state",
      'Use {url: "http://localhost:3000/results"}, {text: "Saved"}, or {ref: "e1-42", state: "visible"}.',
    );
  const { ref, state } = command;
  const element =
    ref !== undefined && state !== undefined
      ? () => options.refs.visible(ref).then((visible) => visible === (state === "visible"))
      : undefined;
  const task = new NavigationTask(options.human, command.timeout, options.clock, options.signal);
  options.policies.start(task);
  try {
    options.checkNavigation();
    await task.run(() =>
      waitForPage(
        options.cdp,
        command,
        task.signal,
        options.clock,
        options.checkNavigation,
        element,
      ),
    );
    options.checkNavigation();
    return { ok: true, url: options.currentUrl() };
  } finally {
    task.close();
    options.policies.finish(task);
  }
}
