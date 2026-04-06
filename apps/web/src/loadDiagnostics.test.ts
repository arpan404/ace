import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetLoadDiagnosticsForTests,
  beginLoadPhase,
  formatLoadDiagnosticsReport,
  getLoadDiagnosticsState,
  logLoadDiagnostic,
} from "./loadDiagnostics";

describe("loadDiagnostics", () => {
  beforeEach(() => {
    __resetLoadDiagnosticsForTests();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records structured load diagnostics entries", () => {
    logLoadDiagnostic({
      phase: "bootstrap",
      message: "Snapshot requested",
      detail: { hydrateThreadId: "thread-1" },
    });

    const snapshot = getLoadDiagnosticsState();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({
      phase: "bootstrap",
      message: "Snapshot requested",
    });
    expect(snapshot.entries[0]?.detail).toContain('"hydrateThreadId": "thread-1"');
  });

  it("records phase durations in the report", () => {
    const phase = beginLoadPhase("ws", "Connecting WebSocket");
    phase.success("WebSocket connected");

    const report = formatLoadDiagnosticsReport();
    expect(report).toContain("[ws] Connecting WebSocket started");
    expect(report).toContain("[ws] WebSocket connected");
    expect(report).toContain("duration");
  });
});
