import { ThreadId } from "@ace/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  selectThreadTerminalPanelState,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "./terminalStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

describe("terminalStateStore actions", () => {
  beforeEach(() => {
    useTerminalStateStore.persist.clearStorage();
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState).toEqual({
      terminalOpen: false,
      terminalHeight: 280,
      terminalSidebarWidth: 236,
      terminalSidebarDensity: "comfortable",
      terminalIds: ["default"],
      terminalSessionIds: ["default", "right-default"],
      runningTerminalIds: [],
      activeTerminalId: "default",
      terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
      activeTerminalGroupId: "group-default",
      customTerminalTitlesById: {},
      autoTerminalTitlesById: {},
      terminalIconsById: {},
      terminalColorsById: {},
      splitRatiosByGroupId: { "group-default": [1] },
      terminalPanelStateByPlacement: {
        bottom: {
          terminalOpen: false,
          terminalHeight: 280,
          terminalIds: ["default"],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
          splitRatiosByGroupId: { "group-default": [1] },
        },
        right: {
          terminalOpen: false,
          terminalHeight: 280,
          terminalIds: ["right-default"],
          activeTerminalId: "right-default",
          terminalGroups: [{ id: "group-right-default", terminalIds: ["right-default"] }],
          activeTerminalGroupId: "group-right-default",
          splitRatiosByGroupId: { "group-right-default": [1] },
        },
      },
    });
  });

  it("opens and splits terminals into the active group", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.splitTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
    expect(terminalState.splitRatiosByGroupId["group-default"]).toEqual([0.5, 0.5]);
  });

  it("allows additional split terminals in the active group", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.splitTerminal(THREAD_ID, "terminal-4");
    store.splitTerminal(THREAD_ID, "terminal-5");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
    ]);
    expect(terminalState.terminalGroups).toEqual([
      {
        id: "group-default",
        terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4", "terminal-5"],
      },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalStateStore.getState().newTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
    expect(terminalState.splitRatiosByGroupId).toEqual({
      "group-default": [1],
      "group-terminal-2": [1],
    });
  });

  it("creates background terminals without opening the bottom drawer", () => {
    useTerminalStateStore.getState().newBackgroundTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(false);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("keeps right panel active and group layout separate from the bottom panel", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "bottom-terminal");
    store.newTerminalForPanel(THREAD_ID, "right", "right-terminal");
    store.setActiveTerminal(THREAD_ID, "default");
    store.setActiveTerminalForPanel(THREAD_ID, "right", "right-terminal");
    store.setTerminalGroupSplitRatiosForPanel(THREAD_ID, "right", "group-right-terminal", [1]);
    store.setActiveTerminalForPanel(THREAD_ID, "right", "bottom-terminal");

    const bottomState = selectThreadTerminalPanelState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
      "bottom",
    );
    const rightState = selectThreadTerminalPanelState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
      "right",
    );

    expect(bottomState.activeTerminalId).toBe("default");
    expect(rightState.activeTerminalId).toBe("right-terminal");
    expect(bottomState.activeTerminalGroupId).toBe("group-default");
    expect(rightState.activeTerminalGroupId).toBe("group-right-terminal");
  });

  it("normalizes legacy panel state without panel terminal ids", () => {
    useTerminalStateStore.setState({
      terminalStateByThreadId: {
        [THREAD_ID]: {
          terminalOpen: false,
          terminalHeight: 280,
          terminalSidebarWidth: 236,
          terminalSidebarDensity: "comfortable",
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
          customTerminalTitlesById: {},
          autoTerminalTitlesById: {},
          terminalIconsById: {},
          terminalColorsById: {},
          splitRatiosByGroupId: { "group-default": [1] },
          terminalPanelStateByPlacement: {
            bottom: {
              terminalOpen: false,
              terminalHeight: 280,
              activeTerminalId: "default",
              terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
              activeTerminalGroupId: "group-default",
              splitRatiosByGroupId: { "group-default": [1] },
            },
            right: {
              terminalOpen: false,
              terminalHeight: 280,
              activeTerminalId: "default",
              terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
              activeTerminalGroupId: "group-default",
              splitRatiosByGroupId: { "group-default": [1] },
            },
          },
        } as never,
      },
    });

    const rightState = selectThreadTerminalPanelState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
      "right",
    );

    expect(rightState.terminalIds).toEqual(["right-default"]);
    expect(rightState.activeTerminalId).toBe("right-default");
  });

  it("returns a stable normalized snapshot for unchanged legacy state", () => {
    useTerminalStateStore.setState({
      terminalStateByThreadId: {
        [THREAD_ID]: {
          terminalOpen: false,
          terminalHeight: 280,
          terminalSidebarWidth: 236,
          terminalSidebarDensity: "comfortable",
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
          customTerminalTitlesById: {},
          autoTerminalTitlesById: {},
          terminalIconsById: {},
          terminalColorsById: {},
          splitRatiosByGroupId: { "group-default": [1] },
          terminalPanelStateByPlacement: {
            bottom: {
              terminalOpen: false,
              terminalHeight: 280,
              activeTerminalId: "default",
              terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
              activeTerminalGroupId: "group-default",
              splitRatiosByGroupId: { "group-default": [1] },
            },
            right: {
              terminalOpen: false,
              terminalHeight: 280,
              activeTerminalId: "default",
              terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
              activeTerminalGroupId: "group-default",
              splitRatiosByGroupId: { "group-default": [1] },
            },
          },
        } as never,
      },
    });

    const firstSnapshot = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    const secondSnapshot = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );

    expect(secondSnapshot).toBe(firstSnapshot);
    expect(secondSnapshot.terminalPanelStateByPlacement.right.terminalIds).toBe(
      firstSnapshot.terminalPanelStateByPlacement.right.terminalIds,
    );
  });

  it("allows unlimited groups while keeping each group capped at four terminals", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.splitTerminal(THREAD_ID, "terminal-4");
    store.newTerminal(THREAD_ID, "terminal-5");
    store.newTerminal(THREAD_ID, "terminal-6");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
      "terminal-6",
    ]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4"] },
      { id: "group-terminal-5", terminalIds: ["terminal-5"] },
      { id: "group-terminal-6", terminalIds: ["terminal-6"] },
    ]);
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.setTerminalActivity(THREAD_ID, "terminal-2", true);
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.setTerminalActivity(THREAD_ID, "terminal-2", false);
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual([]);
  });

  it("persists custom and auto terminal titles", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.renameTerminal(THREAD_ID, "default", "Workspace shell");
    store.setTerminalAutoTitle(THREAD_ID, "terminal-2", "bun dev");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.customTerminalTitlesById).toEqual({ default: "Workspace shell" });
    expect(terminalState.autoTerminalTitlesById).toEqual({ "terminal-2": "bun dev" });
  });

  it("persists terminal icon and color metadata", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.setTerminalIcon(THREAD_ID, "default", "server");
    store.setTerminalColor(THREAD_ID, "terminal-2", "emerald");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIconsById).toEqual({ default: "server" });
    expect(terminalState.terminalColorsById).toEqual({ "terminal-2": "emerald" });
  });

  it("persists and clamps the terminal sidebar width", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalSidebarWidth(THREAD_ID, 412);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalSidebarWidth).toBe(360);
  });

  it("persists terminal sidebar density", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalSidebarDensity(THREAD_ID, "compact");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalSidebarDensity).toBe("compact");
  });

  it("reorders terminals within the active split group", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");

    store.moveTerminal(THREAD_ID, "terminal-3", "group-default", 1);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-3", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-3", "terminal-2"] },
    ]);
  });

  it("moves terminals down within the active split group", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");

    store.moveTerminal(THREAD_ID, "terminal-2", "group-default", 2);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-3", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-3", "terminal-2"] },
    ]);
  });

  it("moves terminals across groups while keeping group state valid", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.newTerminal(THREAD_ID, "terminal-3");

    store.moveTerminal(THREAD_ID, "terminal-2", "group-terminal-3", 1);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-3", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-3", terminalIds: ["terminal-3", "terminal-2"] },
    ]);
    expect(terminalState.splitRatiosByGroupId).toEqual({
      "group-default": [1],
      "group-terminal-3": [0.5, 0.5],
    });
  });

  it("moves a terminal into its own new group", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");

    store.moveTerminalToNewGroup(THREAD_ID, "terminal-2", 1);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-3", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-3"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(THREAD_ID, "default");

    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeUndefined();
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .terminalIds,
    ).toEqual(["default"]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.closeTerminal(THREAD_ID, "terminal-3");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it("prunes orphaned terminal state, including legacy workspace-scoped entries", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.setTerminalOpen(ThreadId.makeUnsafe("workspace-shell:project-1"), true);

    store.removeOrphanedTerminalStates(new Set<ThreadId>([]));

    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeUndefined();
    expect(useTerminalStateStore.getState().terminalStateByThreadId).toEqual({});
  });
});
