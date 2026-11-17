import { ClientProvider } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SafeModeNotice } from "./safe-mode-notice.tsx";

const desktopSentence =
  "ace is running without the part that kept it from starting; restart ace to turn it back on.";

/** The desktop preload's `window.ace.daemon`, reporting `status`. */
function desktop(status: unknown) {
  return {
    ace: {
      platform: "darwin",
      daemon: {
        connection: () => Promise.resolve(undefined),
        status: () => Promise.resolve(status),
        onStatus: () => () => {},
      },
    },
  };
}

/** A connected client whose daemon answers `admission.request` with `admission`. */
function connected(admission: object): ClientApi {
  const connection = { subscribe: () => () => {}, getSnapshot: () => "ready" };
  return {
    state: "ready",
    connectionState: () => connection,
    onMessage: () => () => {},
    request: () => Promise.resolve({ ok: true, admission }),
  } as unknown as ClientApi;
}

const open = { holds: [], busy: 0, waiting: 0 };

test("a daemon that started in safe mode tells every client what it runs without", async () => {
  const client = connected({ ...open, startup: { without: ["Commands"], failing: [] } });
  render(
    <ClientProvider client={client}>
      <SafeModeNotice scope={{}} />
    </ClientProvider>,
  );
  expect(
    await screen.findByText("ace started in safe mode without Commands after repeated crashes."),
  ).toBeTruthy();
});

test("a service that keeps failing is named with the promise to retry", async () => {
  const client = connected({
    ...open,
    startup: { without: [], failing: [{ name: "Commands", retrying: true }] },
  });
  render(
    <ClientProvider client={client}>
      <SafeModeNotice scope={{}} />
    </ClientProvider>,
  );
  expect(
    await screen.findByText("Commands isn't working right now; ace is retrying."),
  ).toBeTruthy();
});

test("a service out of retries tells the person to restart instead of promising one", async () => {
  const client = connected({
    ...open,
    startup: { without: [], failing: [{ name: "Commands", retrying: false }] },
  });
  render(
    <ClientProvider client={client}>
      <SafeModeNotice scope={{}} />
    </ClientProvider>,
  );
  expect(await screen.findByText("Commands isn't working; restart ace to try again.")).toBeTruthy();
});

test("a healthy daemon shows nothing, whatever the desktop remembers", async () => {
  const client = connected(open);
  const { container } = render(
    <ClientProvider client={client}>
      <SafeModeNotice scope={desktop({ state: "running", message: desktopSentence })} />
    </ClientProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(container.textContent).toBe("");
});

test("with no daemon answer yet, the desktop's own sentence stands in", async () => {
  render(<SafeModeNotice scope={desktop({ state: "running", message: desktopSentence })} />);
  expect(await screen.findByText(desktopSentence)).toBeTruthy();
});
