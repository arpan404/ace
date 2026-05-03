import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  mergeMobileBrowserHistoryState,
  useMobileBrowserHistoryStore,
} from "./MobileBrowserHistoryStore";

describe("MobileBrowserHistoryStore", () => {
  beforeEach(() => {
    useMobileBrowserHistoryStore.setState(
      {
        ...useMobileBrowserHistoryStore.getInitialState(),
        history: [],
      },
      true,
    );
  });

  it("records visits through the shared browser history helper", () => {
    const state = useMobileBrowserHistoryStore.getState();

    state.recordVisit({
      title: "Example",
      url: "https://example.com/",
      visitedAt: 10,
      visitCount: 0,
    });
    state.recordVisit({
      title: "Example 2",
      url: "https://example.com/",
      visitedAt: 20,
      visitCount: 0,
    });

    expect(useMobileBrowserHistoryStore.getState().history).toEqual([
      {
        title: "Example 2",
        url: "https://example.com/",
        visitedAt: 20,
        visitCount: 2,
      },
    ]);
  });

  it("filters invalid persisted history entries", () => {
    const current = useMobileBrowserHistoryStore.getInitialState();
    const merged = mergeMobileBrowserHistoryState(
      {
        history: [
          { title: "Docs", url: "https://docs.example.com/", visitedAt: 10, visitCount: 1 },
          { title: "Bad", url: 7, visitedAt: 10, visitCount: 1 },
        ],
      },
      current,
    );

    expect(merged.history).toEqual([
      { title: "Docs", url: "https://docs.example.com/", visitedAt: 10, visitCount: 1 },
    ]);
    expect(merged.recordVisit).toBe(current.recordVisit);
  });

  it("clears stored history", () => {
    const state = useMobileBrowserHistoryStore.getState();

    state.recordVisit({
      title: "Example",
      url: "https://example.com/",
      visitedAt: 10,
      visitCount: 0,
    });
    state.clearHistory();

    expect(useMobileBrowserHistoryStore.getState().history).toEqual([]);
  });
});
