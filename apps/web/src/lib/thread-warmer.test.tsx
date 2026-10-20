import { ClientProvider, useThreadMeta } from "@ace/client-react";
import { FakeDaemon, facts, workbench } from "@ace/fake-daemon";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { expect, test, vi } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import { harness } from "@/test/harness.tsx";
import { ThreadWarmer, warmHoldMs, warmThreads } from "./thread-warmer.ts";

function daemonWith(ids: readonly string[]) {
  const daemon = new FakeDaemon({ clock: () => 1 });
  for (const id of ids) {
    daemon.createThread({ id, workspaceId: "ace", title: `Thread ${id}`, provider: "codex" });
    daemon.apply(id, [facts.rootAgent("codex"), facts.message("root", "ask", "user", `Ask ${id}`)]);
  }
  return daemon;
}

/** A schedule the test runs by hand. */
function manualSchedule() {
  const jobs = new Set<{ delayMs: number; run: () => void }>();
  return {
    schedule(delayMs: number, run: () => void) {
      const job = { delayMs, run };
      jobs.add(job);
      return () => {
        jobs.delete(job);
      };
    },
    elapse(delayMs: number) {
      for (const job of jobs)
        if (job.delayMs <= delayMs) {
          jobs.delete(job);
          job.run();
        }
    },
  };
}

test("a thread pointed at before it is opened paints its title on the view's first commit", async () => {
  const daemon = daemonWith(["warm"]);
  const client = fakeClient(daemon);
  await client.start();
  const time = manualSchedule();
  new ThreadWarmer(client, time.schedule).warm("warm");
  await vi.waitFor(() => expect(client.cachedThread("warm")?.thread?.title).toBe("Thread warm"));
  const commits: (string | undefined)[] = [];
  function View() {
    const meta = useThreadMeta("warm");
    useLayoutEffect(() => {
      commits.push(meta?.title);
    }, [meta]);
    return <p>{meta?.title ?? "Loading"}</p>;
  }
  render(
    <ClientProvider client={client}>
      <View />
    </ClientProvider>,
  );
  expect(commits[0]).toBe("Thread warm");
  expect(screen.queryByText("Loading")).toBeNull();
});

test("a warmed thread stays followed for a while, then is kept only as an unconfirmed copy", async () => {
  const daemon = daemonWith(["warm"]);
  const client = fakeClient(daemon);
  await client.start();
  const time = manualSchedule();
  new ThreadWarmer(client, time.schedule).warm("warm");
  await vi.waitFor(() => expect(client.cachedThread("warm")?.thread?.title).toBe("Thread warm"));
  time.elapse(warmHoldMs - 1);
  expect(client.cachedThread("warm")?.unconfirmed).toBe(false);
  time.elapse(warmHoldMs);
  // Nothing follows it now: a view opening it shows it as syncing until the daemon confirms.
  expect(client.cachedThread("warm")?.unconfirmed).toBe(true);
  expect(client.cachedThread("warm")?.thread?.title).toBe("Thread warm");
});

test("pointing at more threads than it holds lets the least recently pointed at go", async () => {
  const ids = Array.from({ length: warmThreads + 1 }, (_, index) => `t${index}`);
  const daemon = daemonWith(ids);
  const client = fakeClient(daemon);
  await client.start();
  const warmer = new ThreadWarmer(client, manualSchedule().schedule);
  for (const id of ids.slice(0, warmThreads)) warmer.warm(id);
  await vi.waitFor(() =>
    expect(ids.slice(0, warmThreads).map((id) => client.cachedThread(id)?.cursor)).not.toContain(
      undefined,
    ),
  );
  // Pointed at again: now the most recent, so the next one pushes out t1 instead.
  warmer.warm("t0");
  warmer.warm(ids[warmThreads] ?? "");
  await vi.waitFor(() =>
    expect(ids.map((id) => client.cachedThread(id)?.unconfirmed)).toEqual([
      false,
      true,
      ...ids.slice(2).map(() => false),
    ]),
  );
});

test("touching a thread in the list starts following it before it is opened", async () => {
  const app = harness({ throughWorker: true });
  const [scenario] = workbench();
  if (!scenario) throw new Error("No workbench scenario");
  app.play(scenario).runUntilBlocked();
  const { id, title } = scenario.thread;
  // New thread: the list shows, and no thread is open (Home may reopen the last one).
  await app.open("/new");
  const list = await screen.findByRole("navigation", { name: "Threads" });
  const row = await within(list).findByRole("link", { name: new RegExp(`^${title}`) });
  expect(app.client.cachedThread?.(id)?.thread).toBeUndefined();
  // A phone has no hover card: the touch that starts a tap is the first sign of intent.
  fireEvent.touchStart(row);
  await vi.waitFor(() => expect(app.client.cachedThread?.(id)?.thread?.title).toBe(title));
});
