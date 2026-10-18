/**
 * Certificates the person chose to trust in one thread's browser, each for one origin. Electron
 * asks on every load that fails verification; only an exact origin and certificate match passes.
 * Kept in memory for the thread's views only: nothing is written and agents never add to it.
 */
export class CertificateExceptions {
  private allowed = new Set<string>();
  allow(url: string, fingerprint: string): void {
    const key = exceptionKey(url, fingerprint);
    if (key && this.allowed.size < 256) this.allowed.add(key);
  }
  allows(url: string, fingerprint: string): boolean {
    const key = exceptionKey(url, fingerprint);
    return key !== undefined && this.allowed.has(key);
  }
}

function exceptionKey(url: string, fingerprint: string): string | undefined {
  try {
    const { origin, protocol } = new URL(url);
    return protocol === "https:" || protocol === "wss:" ? `${origin} ${fingerprint}` : undefined;
  } catch {
    return undefined;
  }
}
