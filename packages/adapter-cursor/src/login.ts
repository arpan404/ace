import { z } from "zod";
import { CursorInstance } from "./instance.ts";
import type { createCursorAccountDriver } from "./auth.ts";

export interface CursorLoginProgress {
  state: "starting" | "browser" | "complete" | "failed" | "cancelled";
  url?: string;
  userCode?: string;
  prompt?: string;
}
const loginUrl = z.intersection(z.url().max(8192), z.string().regex(/^(?!.*\s)https:\/\/\S+$/));

/** Ephemeral browser progress for the in-app login owner. No credential entry or replay. */
export function createCursorLoginDriver(
  input: CursorInstance,
  account: Pick<ReturnType<typeof createCursorAccountDriver>, "login">,
) {
  const instance = CursorInstance.parse(input);
  return {
    async *start(signal: AbortSignal): AsyncGenerator<CursorLoginProgress> {
      if (signal.aborted) {
        yield { state: "cancelled" };
        return;
      }
      yield { state: "starting" };
      const controller = new AbortController();
      const joined = AbortSignal.any([signal, controller.signal]);
      let wake = Promise.withResolvers<void>();
      let url: string | undefined;
      let outcome: "complete" | "failed" | "cancelled" | undefined;
      // One pending challenge bounds memory even if a faulty SDK repeats notifications.
      const work = Promise.resolve()
        .then(() =>
          account.login(instance, joined, (value) => {
            const parsed = loginUrl.safeParse(value);
            if (!parsed.success) throw new Error("Invalid SDK browser challenge");
            url = parsed.data;
            wake.resolve();
          }),
        )
        .then(
          (status) => {
            outcome = joined.aborted
              ? "cancelled"
              : status.status === "logged-in"
                ? "complete"
                : "failed";
          },
          () => {
            outcome = joined.aborted ? "cancelled" : "failed";
          },
        )
        .finally(() => wake.resolve());
      try {
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- SDK completion changes outcome asynchronously.
        while (!outcome) {
          await wake.promise;
          wake = Promise.withResolvers<void>();
          if (url && !joined.aborted) {
            const challenge = url;
            url = undefined;
            yield { state: "browser", url: challenge, prompt: "Sign in to Cursor in your browser" };
          }
        }
        yield { state: outcome };
      } finally {
        controller.abort();
        await work;
      }
    },
  };
}
