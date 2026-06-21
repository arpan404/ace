export function resolveBrowserSessionUserAgent(rawUserAgent: string): string {
  const normalized = rawUserAgent
    .replace(/\sElectron\/\S+/gu, "")
    .replace(/\sace\/\S+/giu, "")
    .replace(/\s+/gu, " ")
    .trim();

  return normalized.length > 0 ? normalized : rawUserAgent;
}
