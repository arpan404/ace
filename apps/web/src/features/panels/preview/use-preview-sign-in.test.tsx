import { renderHook, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Schedule } from "../schedule.ts";
import type { PreviewLink, PreviewSource } from "../sources.ts";
import { usePreviewSignIn } from "./use-preview-sign-in.ts";

/** Timers the test fires by hand, remembering how far ahead each was set. */
function manualTimers() {
  const due = new Map<() => void, number>();
  const schedule: Schedule = (callback, ms) => {
    due.set(callback, ms);
    return () => due.delete(callback);
  };
  return {
    schedule,
    delays: () => [...due.values()],
    fire() {
      const now = [...due.keys()];
      due.clear();
      for (const callback of now) callback();
    },
  };
}

/** A daemon that issues numbered single-use links, or refuses while `refusing` is set. */
function linkSource() {
  let issued = 0;
  const state = { refusing: undefined as string | undefined };
  const link = async (): Promise<PreviewLink> => {
    if (state.refusing) throw new Error(state.refusing);
    issued++;
    return {
      url: `http://p3000-a.preview.localhost:9/.ace-preview/login?token=${issued}`,
      sessionMs: 3_600_000,
    };
  };
  return { source: { link } as unknown as PreviewSource, state, issued: () => issued };
}

const server = { port: 3000, origin: "http://p3000-a.preview.localhost:9" };

test("a framed preview renews its session five minutes before the hour, without reloading the frame", async () => {
  const daemon = linkSource();
  const timers = manualTimers();
  const renewed: string[] = [];
  const renew = async (url: string) => {
    renewed.push(url);
  };
  const { result } = renderHook(() =>
    usePreviewSignIn(daemon.source, "thread", server, "0", { schedule: timers.schedule, renew }),
  );
  await waitFor(() => expect(result.current).toMatchObject({ phase: "ready", renewals: 0 }));
  const src = result.current.phase === "ready" ? result.current.src : "";
  expect(src).toMatch(/token=1$/);
  expect(timers.delays()).toEqual([55 * 60_000]);

  timers.fire();
  await waitFor(() => expect(result.current).toMatchObject({ phase: "ready", renewals: 1 }));
  // A fresh single-use link was redeemed in the background; the frame keeps its first address.
  expect(renewed).toEqual([expect.stringMatching(/token=2$/)]);
  expect(result.current).toMatchObject({ src });
  expect(timers.delays()).toEqual([55 * 60_000]);
});

test("a renewal the daemon refuses tries again a minute later while the session still runs", async () => {
  const daemon = linkSource();
  const timers = manualTimers();
  const renewed: string[] = [];
  const renew = async (url: string) => {
    renewed.push(url);
  };
  const { result } = renderHook(() =>
    usePreviewSignIn(daemon.source, "thread", server, "0", { schedule: timers.schedule, renew }),
  );
  await waitFor(() => expect(result.current.phase).toBe("ready"));
  daemon.state.refusing = "preview_link_refused";
  timers.fire();
  await waitFor(() => expect(timers.delays()).toEqual([60_000]));
  expect(renewed).toEqual([]);

  daemon.state.refusing = undefined;
  timers.fire();
  await waitFor(() => expect(result.current).toMatchObject({ phase: "ready", renewals: 1 }));
  expect(renewed).toHaveLength(1);
});

test("leaving the preview stops renewing it", async () => {
  const daemon = linkSource();
  const timers = manualTimers();
  const { result, unmount } = renderHook(() =>
    usePreviewSignIn(daemon.source, "thread", server, "0", {
      schedule: timers.schedule,
      renew: async () => {},
    }),
  );
  await waitFor(() => expect(result.current.phase).toBe("ready"));
  unmount();
  expect(timers.delays()).toEqual([]);
  expect(daemon.issued()).toBe(1);
});
