/** Inline sidebar dimensions; the phone drawer keeps its own sizing. */
export const sidebarSize = { minimum: 220, collapse: 180, maximum: 480, initial: 280 };

export function sidebarMaximum(viewport: number): number {
  return Math.max(sidebarSize.minimum, Math.min(sidebarSize.maximum, viewport * 0.4));
}

export function sidebarWidth(width: number, viewport: number): number {
  return Math.max(sidebarSize.minimum, Math.min(sidebarMaximum(viewport), width));
}
