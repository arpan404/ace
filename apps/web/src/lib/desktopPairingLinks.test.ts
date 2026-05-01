import { afterEach, describe, expect, it, vi } from "vitest";

import {
  queueDesktopPairingLink,
  subscribeToDesktopPairingLinks,
  takePendingDesktopPairingLink,
} from "./desktopPairingLinks";

describe("desktopPairingLinks", () => {
  afterEach(() => {
    while (takePendingDesktopPairingLink() !== null) {
      // Clear pending queue between tests.
    }
    vi.unstubAllGlobals();
  });

  it("queues pairing links in order", () => {
    queueDesktopPairingLink("ace://pair?p=first");
    queueDesktopPairingLink("ace://pair?p=second");

    expect(takePendingDesktopPairingLink()).toBe("ace://pair?p=first");
    expect(takePendingDesktopPairingLink()).toBe("ace://pair?p=second");
    expect(takePendingDesktopPairingLink()).toBeNull();
  });

  it("notifies listeners when a pairing link is queued", () => {
    const eventTarget = new EventTarget();
    vi.stubGlobal("window", {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    });

    const listener = vi.fn();
    const unsubscribe = subscribeToDesktopPairingLinks(listener);

    queueDesktopPairingLink("ace://pair?p=next");

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
