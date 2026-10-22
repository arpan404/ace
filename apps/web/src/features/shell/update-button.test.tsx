import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { UpdateButton } from "./update-button.tsx";

const releaseUrl = "https://github.com/arpan404/ace/releases/tag/v1.1.0";
const notes = [
  { version: "1.1.0", items: ["Persist views across restarts (#985)"], total: 3 },
  { version: "1.0.5", items: ["Faster startup (#970)"], total: 1 },
];

/** The desktop preload's update status, with anything a case changes. */
function status(overrides: Record<string, unknown> = {}) {
  return {
    state: "idle",
    currentVersion: "1.0.0",
    version: null,
    releaseUrl: null,
    inPlace: true,
    percent: null,
    waiting: 0,
    notes: [],
    olderReleases: 0,
    error: null,
    ...overrides,
  };
}
const offer = (overrides: Record<string, unknown> = {}) =>
  status({ state: "available", version: "1.1.0", releaseUrl, notes, ...overrides });

/** The desktop preload's `window.ace.updates` and `shell`, steered by the test. */
function desktop(
  initial: unknown = status(),
  checked: unknown = status({ state: "current" }),
  busy: number | Error = 0,
) {
  let report: ((value: unknown) => void) | undefined;
  const calls: string[] = [];
  const opened: string[] = [];
  const scope = {
    ace: {
      updates: {
        current: () => Promise.resolve(initial),
        check: () => {
          calls.push("check");
          return Promise.resolve(checked);
        },
        download: () => {
          calls.push("download");
          return Promise.resolve(initial);
        },
        install: () => {
          calls.push("install");
          return Promise.resolve(initial);
        },
        busy: () => (busy instanceof Error ? Promise.reject(busy) : Promise.resolve(busy)),
        onStatus(listener: (value: unknown) => void) {
          report = listener;
          return () => {};
        },
      },
      shell: {
        openExternal: (address: string) => {
          opened.push(address);
          return Promise.resolve();
        },
      },
    },
  };
  render(
    <ToastProvider>
      <UpdateButton scope={scope} />
    </ToastProvider>,
  );
  return { calls, opened, report: (value: unknown) => act(() => report?.(value)) };
}

test("a build without the release feed shows no update button", async () => {
  desktop(status({ state: "disabled" }));
  await act(() => Promise.resolve());
  expect(screen.queryByRole("button")).toBeNull();
});

test("no update button shows until a check finds an update", async () => {
  const app = desktop(status());
  await act(() => Promise.resolve());
  expect(screen.queryByRole("button")).toBeNull();
  app.report(status({ state: "checking" }));
  app.report(status({ state: "current" }));
  app.report(status({ state: "error", error: { during: "check", message: "Offline" } }));
  expect(screen.queryByRole("button")).toBeNull();
  app.report(offer());
  expect(screen.getByRole("button", { name: "Update 1.1.0 ready to download" })).toBeTruthy();
});

test("a found update downloads on click, showing its progress", async () => {
  const app = desktop(offer());
  await userEvent.click(
    await screen.findByRole("button", { name: "Update 1.1.0 ready to download" }),
  );
  expect(app.calls).toEqual(["download"]);
  app.report(offer({ state: "downloading", percent: 42.6 }));
  const downloading = screen.getByRole("button", { name: "Downloading update (42%)" });
  expect(downloading.getAttribute("aria-disabled")).toBe("true");
});

test("hovering an update in hand shows what changed in every newer release", async () => {
  desktop(offer({ olderReleases: 2 }));
  await userEvent.hover(
    await screen.findByRole("button", { name: "Update 1.1.0 ready to download" }),
  );
  expect(await screen.findByText("What's changed")).toBeTruthy();
  expect(screen.getByText("Persist views across restarts (#985)")).toBeTruthy();
  expect(screen.getByText("2 more changes on GitHub")).toBeTruthy();
  expect(screen.getByText("Changes in 1.0.5")).toBeTruthy();
  expect(screen.getByText("2 older releases on GitHub")).toBeTruthy();
});

const restartButton = () =>
  screen.findByRole("button", { name: "Update 1.1.0 downloaded. Click to restart and install." });

test("a downloaded update restarts only after the person confirms", async () => {
  const app = desktop(offer({ state: "downloaded", percent: 100 }));
  await userEvent.click(await restartButton());
  expect(await screen.findByText("Restart to update?")).toBeTruthy();
  expect(await screen.findByText("Nothing is running. ace is back in a few seconds.")).toBeTruthy();
  expect(app.calls).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Restart" }));
  expect(app.calls).toEqual(["install"]);
});

test("Restart warns how many agents on this computer it stops, then stops them", async () => {
  const app = desktop(offer({ state: "downloaded", percent: 100 }), undefined, 2);
  await userEvent.click(await restartButton());
  expect(
    await screen.findByText(
      "2 agents on this computer will stop. Their threads keep their progress.",
    ),
  ).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })),
  );
  await userEvent.click(screen.getByRole("button", { name: "Restart anyway" }));
  expect(app.calls).toEqual(["install"]);
});

test("when the agent count is unknown, Restart still warns that agents stop", async () => {
  desktop(offer({ state: "downloaded", percent: 100 }), undefined, new Error("daemon gone"));
  await userEvent.click(await restartButton());
  expect(
    await screen.findByText(
      "Agents running on this computer will stop. Their threads keep their progress.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restart anyway" })).toBeTruthy();
});

test("while agents finish, the button says how many it waits for", async () => {
  const app = desktop(offer({ state: "downloaded" }));
  await screen.findByRole("button", { name: /downloaded/ });
  app.report(offer({ state: "installing", waiting: 2 }));
  expect(screen.getByRole("button", { name: "Updating when 2 agents finish" })).toBeTruthy();
});

test("an update this app can't install itself opens its release page", async () => {
  const app = desktop(offer({ inPlace: false }));
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Update 1.1.0 available. Click to download it from GitHub.",
    }),
  );
  expect(app.opened).toEqual([releaseUrl]);
  expect(app.calls).toEqual([]);
});

test("a failed download offers a retry", async () => {
  const app = desktop(offer({ error: { during: "download", message: "net::ERR_FAILED" } }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Download failed for 1.1.0. Click to retry." }),
  );
  expect(app.calls).toEqual(["download"]);
});
