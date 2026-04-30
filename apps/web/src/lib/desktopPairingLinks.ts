const DESKTOP_PAIRING_LINK_EVENT = "ace:desktop-pairing-link";

const pendingDesktopPairingLinks: string[] = [];

export function queueDesktopPairingLink(input: string): void {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return;
  }

  pendingDesktopPairingLinks.push(trimmed);
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(DESKTOP_PAIRING_LINK_EVENT));
}

export function takePendingDesktopPairingLink(): string | null {
  return pendingDesktopPairingLinks.shift() ?? null;
}

export function subscribeToDesktopPairingLinks(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleRequest = () => {
    listener();
  };

  window.addEventListener(DESKTOP_PAIRING_LINK_EVENT, handleRequest);
  return () => {
    window.removeEventListener(DESKTOP_PAIRING_LINK_EVENT, handleRequest);
  };
}
