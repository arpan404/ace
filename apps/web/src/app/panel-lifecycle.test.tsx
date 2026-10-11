import type { ClientApi } from "@ace/client";
import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { App, AppFrame } from "@/app.tsx";
import type { PageVisibility } from "@/lib/page-visibility.ts";
import { fakeClient } from "@/test/fake-client.ts";
import { daemonPreview } from "@/features/panels/preview/daemon-preview.ts";
import { panelServices, type PanelServices } from "@/features/panels/services.ts";
import { daemonTerminals } from "@/features/panels/terminal/daemon-terminals.ts";
import { TerminalSessions } from "@/features/panels/terminal/sessions.ts";

function documentBoundary() {
  const listeners = new Set<() => void>();
  const released: string[] = [];
  let sequence = 0;
  const visibility: PageVisibility = {
    visible: () => true,
    watch(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    listeners,
    released,
    sources(client: ClientApi) {
      return {
        terminals: new TerminalSessions(daemonTerminals(client)),
        preview: daemonPreview(client, {
          visibility,
          decode: async () => {
            const src = `lifecycle-frame-${++sequence}`;
            return {
              src,
              release: () => {
                released.push(src);
              },
            };
          },
        }),
      };
    },
  };
}

function renderer(client: ClientApi, key: string) {
  return (
    <AppFrame environment={{}}>
      <App key={key} client={client} history={createMemoryHistory({ initialEntries: ["/"] })} />
    </AppFrame>
  );
}

async function warm(sources: Pick<PanelServices, "preview">) {
  const unwatch = sources.preview.watch("thread-settings");
  await sources.preview.open("thread-settings", failingSubagent().thread.workspaceId);
  await waitFor(() => expect(sources.preview.frame("thread-settings")).toBeDefined());
  unwatch();
  await Promise.resolve();
  const src = sources.preview.frame("thread-settings")?.src;
  if (!src) throw new Error("Missing warm frame");
  return src;
}

test("replacing the App client retires its warm preview while preserving the new client's cache", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const first = fakeClient(daemon);
  const next = fakeClient(daemon);
  await first.start();
  await next.start();
  await waitFor(() => {
    expect(first.state).toBe("ready");
    expect(next.state).toBe("ready");
  });
  const boundary = documentBoundary();
  const retired = await panelServices(first, async () => boundary.sources(first));
  const oldFrame = await warm(retired);
  const current = await panelServices(next, async () => boundary.sources(next));
  const currentFrame = await warm(current);
  const view = render(renderer(first, "first"));
  view.rerender(renderer(next, "next"));
  await waitFor(() => expect(boundary.listeners.size).toBe(1));
  expect(retired.preview.frame("thread-settings")).toBeUndefined();
  expect(boundary.released.filter((src) => src === oldFrame)).toEqual([oldFrame]);
  expect(current.preview.frame("thread-settings")?.src).toBe(currentFrame);
  expect(boundary.released).not.toContain(currentFrame);
  view.unmount();
  expect(boundary.listeners.size).toBe(0);
  expect(boundary.released.filter((src) => src === currentFrame)).toEqual([currentFrame]);
});

test("a pending panel load completing after App retirement releases its frames and cannot revive its owner", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const boundary = documentBoundary();
  const chunk = Promise.withResolvers<Pick<PanelServices, "terminals" | "preview">>();
  const loading = panelServices(client, () => chunk.promise);
  const sources = boundary.sources(client);
  const frame = await warm(sources);
  const view = render(renderer(client, "pending"));
  view.unmount();
  await act(async () => {
    chunk.resolve(sources);
    await expect(loading).rejects.toThrow("panel_services_disposed");
  });
  expect(boundary.listeners.size).toBe(0);
  expect(sources.preview.frame("thread-settings")).toBeUndefined();
  expect(boundary.released.filter((src) => src === frame)).toEqual([frame]);
  const fresh = await panelServices(client, async () => boundary.sources(client));
  expect(await warm(fresh)).not.toBe(frame);
  // A new mounted owner releases only its own resources when it leaves.
  const replacement = render(renderer(client, "fresh"));
  replacement.unmount();
  expect(boundary.listeners.size).toBe(0);
});
