import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  mergeMobileBrowserSessionState,
  useMobileBrowserSessionStore,
} from "./MobileBrowserSessionStore";

describe("MobileBrowserSessionStore", () => {
  beforeEach(() => {
    useMobileBrowserSessionStore.setState(
      {
        ...useMobileBrowserSessionStore.getInitialState(),
        activeTabId: null,
        tabs: [],
      },
      true,
    );
  });

  it("persists a normalized active tab session", () => {
    const state = useMobileBrowserSessionStore.getState();

    state.setSession(
      [
        {
          id: "tab-a",
          url: "https://example.com/",
          title: "Example",
          canGoBack: false,
          canGoForward: true,
        },
      ],
      "tab-a",
    );

    expect(useMobileBrowserSessionStore.getState()).toMatchObject({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          url: "https://example.com/",
          title: "Example",
          canGoBack: false,
          canGoForward: true,
        },
      ],
    });
  });

  it("filters invalid persisted tabs and falls back to a valid active tab", () => {
    const current = useMobileBrowserSessionStore.getInitialState();
    const merged = mergeMobileBrowserSessionState(
      {
        activeTabId: "missing",
        tabs: [
          {
            id: "tab-a",
            url: "https://example.com/",
            title: "Example",
            canGoBack: false,
            canGoForward: false,
          },
          {
            id: "",
            url: "https://bad.example/",
            title: "Bad",
            canGoBack: false,
            canGoForward: false,
          },
        ],
      },
      current,
    );

    expect(merged.activeTabId).toBe("tab-a");
    expect(merged.tabs).toEqual([
      {
        id: "tab-a",
        url: "https://example.com/",
        title: "Example",
        canGoBack: false,
        canGoForward: false,
      },
    ]);
    expect(merged.setSession).toBe(current.setSession);
  });

  it("clears the persisted browser session", () => {
    const state = useMobileBrowserSessionStore.getState();

    state.setSession(
      [
        {
          id: "tab-a",
          url: "https://example.com/",
          title: "Example",
          canGoBack: false,
          canGoForward: false,
        },
      ],
      "tab-a",
    );
    state.clearSession();

    expect(useMobileBrowserSessionStore.getState()).toMatchObject({
      activeTabId: null,
      tabs: [],
    });
  });
});
