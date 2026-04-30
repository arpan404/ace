const ACE_PROTOCOL = "ace:";
const PAIRING_TARGET = "pair";

function normalizePairingTarget(input: URL): string {
  const hostname = input.hostname.trim().toLowerCase();
  if (hostname.length > 0) {
    return hostname;
  }
  return input.pathname.replace(/^\/+/, "").trim().toLowerCase();
}

export function normalizeDesktopPairingUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== ACE_PROTOCOL) {
      return null;
    }
    if (normalizePairingTarget(parsed) !== PAIRING_TARGET) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function findDesktopPairingUrlInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const pairingUrl = normalizeDesktopPairingUrl(arg);
    if (pairingUrl) {
      return pairingUrl;
    }
  }
  return null;
}
