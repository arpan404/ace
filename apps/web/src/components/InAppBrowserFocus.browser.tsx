import "../index.css";

import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { removeLocalStorageItem } from "~/hooks/useLocalStorage";
import { useInAppBrowserState, type InAppBrowserMode } from "~/hooks/useInAppBrowserState";
import { BROWSER_HISTORY_STORAGE_KEY } from "~/lib/browser/history";
import {
  BROWSER_SESSION_STORAGE_KEY,
  resolveBrowserSessionStorageKey,
} from "~/lib/browser/session";

vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => ({
    browserSearchEngine: "google",
  }),
  useUpdateSettings: () => ({
    updateSettings: vi.fn(),
  }),
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => undefined,
}));

function resetBrowserStorage() {
  removeLocalStorageItem(BROWSER_SESSION_STORAGE_KEY);
  removeLocalStorageItem(resolveBrowserSessionStorageKey("thread-a"));
  removeLocalStorageItem(resolveBrowserSessionStorageKey("thread-b"));
  removeLocalStorageItem(BROWSER_HISTORY_STORAGE_KEY);
}

function queryAddressInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Browser address bar"]');
}

function BrowserFocusHarnessPanel(props: { mode: InAppBrowserMode }) {
  const state = useInAppBrowserState({ mode: props.mode, open: true });

  return (
    <div>
      <input
        aria-label="Browser address bar"
        ref={state.addressInputRef}
        value={state.draftUrl}
        readOnly
      />
      <button type="button" onClick={state.openNewTab}>
        Open new tab
      </button>
    </div>
  );
}

function BrowserFocusHarness() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<InAppBrowserMode>("full");

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setMode("full");
          setOpen(true);
        }}
      >
        Open browser
      </button>
      <button type="button" onClick={() => setMode("split")} disabled={!open}>
        Split browser
      </button>
      <button type="button" onClick={() => setMode("full")} disabled={!open}>
        Restore browser
      </button>
      {open ? <BrowserFocusHarnessPanel mode={mode} /> : null}
    </div>
  );
}

describe("InAppBrowser address bar focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBrowserStorage();
  });

  it("focuses only on first open and explicit new-tab creation", async () => {
    const screen = await render(<BrowserFocusHarness />);

    await screen.getByText("Open browser").click();

    await vi.waitFor(() => {
      const input = queryAddressInput();
      expect(input).toBeTruthy();
      expect(document.activeElement).toBe(input);
    });

    await screen.getByText("Split browser").click();

    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(queryAddressInput());
    });

    await screen.getByText("Restore browser").click();

    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(queryAddressInput());
    });

    await screen.getByText("Open new tab").click();

    await vi.waitFor(() => {
      const input = queryAddressInput();
      expect(input).toBeTruthy();
      expect(document.activeElement).toBe(input);
    });
  });
});

function BrowserScopeHarnessPanel(props: { scopeId: string }) {
  const state = useInAppBrowserState({ mode: "full", open: true, scopeId: props.scopeId });

  return (
    <div>
      <div aria-label="Tab count">{state.browserSession.tabs.length}</div>
      <button type="button" onClick={state.openNewTab}>
        Open scoped tab
      </button>
    </div>
  );
}

function BrowserScopeHarness() {
  const [scopeId, setScopeId] = useState("thread-a");

  return (
    <div>
      <button type="button" onClick={() => setScopeId("thread-a")}>
        Thread A
      </button>
      <button type="button" onClick={() => setScopeId("thread-b")}>
        Thread B
      </button>
      <BrowserScopeHarnessPanel scopeId={scopeId} />
    </div>
  );
}

describe("InAppBrowser scoped sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBrowserStorage();
  });

  it("preserves tab state per scope", async () => {
    const screen = await render(<BrowserScopeHarness />);

    await expect.element(screen.getByLabelText("Tab count")).toHaveTextContent("1");

    await screen.getByText("Open scoped tab").click();
    await expect.element(screen.getByLabelText("Tab count")).toHaveTextContent("2");

    await screen.getByText("Thread B").click();
    await expect.element(screen.getByLabelText("Tab count")).toHaveTextContent("1");

    await screen.getByText("Thread A").click();
    await expect.element(screen.getByLabelText("Tab count")).toHaveTextContent("2");
  });
});
