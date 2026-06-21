import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: vi.fn(() => "toast-id"),
    update: vi.fn(),
    close: vi.fn(),
  },
}));

import {
  applyTransportConnectionHealthState,
  getConnectionHealthSnapshot,
  resetConnectionHealthForTests,
  setConnectionHealthToastsEnabled,
} from "./connectionHealth";
import { toastManager } from "~/components/ui/toast";

describe("connectionHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConnectionHealthForTests();
  });

  it("starts connecting and becomes healthy on first connect", () => {
    expect(getConnectionHealthSnapshot().kind).toBe("connecting");

    applyTransportConnectionHealthState({ kind: "connected" });

    expect(getConnectionHealthSnapshot()).toMatchObject({
      kind: "healthy",
      reconnectCount: 0,
      lastError: null,
    });
    expect(getConnectionHealthSnapshot().lastConnectedAt).toEqual(expect.any(Number));
  });

  it("tracks disconnect and reconnect details", () => {
    applyTransportConnectionHealthState({ kind: "connected" });
    applyTransportConnectionHealthState({ kind: "disconnected", error: "socket closed" });

    expect(getConnectionHealthSnapshot()).toMatchObject({
      kind: "disconnected",
      lastError: "socket closed",
      reconnectCount: 0,
    });
    expect(getConnectionHealthSnapshot().lastDisconnectedAt).toEqual(expect.any(Number));

    applyTransportConnectionHealthState({ kind: "reconnected" });

    expect(getConnectionHealthSnapshot()).toMatchObject({
      kind: "healthy",
      lastError: null,
      reconnectCount: 1,
    });
  });

  it("does not show connection toasts until reliability UX is enabled", () => {
    applyTransportConnectionHealthState({ kind: "connected" });
    applyTransportConnectionHealthState({ kind: "disconnected", error: "socket closed" });
    applyTransportConnectionHealthState({ kind: "reconnected" });

    expect(toastManager.add).not.toHaveBeenCalled();
    expect(toastManager.update).not.toHaveBeenCalled();
  });

  it("shows connection toasts when reliability UX is enabled", () => {
    setConnectionHealthToastsEnabled(true);
    applyTransportConnectionHealthState({ kind: "connected" });
    applyTransportConnectionHealthState({ kind: "disconnected", error: "socket closed" });
    applyTransportConnectionHealthState({ kind: "reconnected" });

    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Connection interrupted" }),
    );
    expect(toastManager.update).toHaveBeenCalledWith(
      "toast-id",
      expect.objectContaining({ title: "Reconnected" }),
    );
  });

  it("does not emit duplicate snapshots for repeated identical disconnects", () => {
    applyTransportConnectionHealthState({ kind: "connected" });
    applyTransportConnectionHealthState({ kind: "disconnected", error: "socket closed" });
    const first = getConnectionHealthSnapshot();

    applyTransportConnectionHealthState({ kind: "disconnected", error: "socket closed" });

    expect(getConnectionHealthSnapshot()).toBe(first);
  });
});
