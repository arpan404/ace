/*
 * The size each thread's page last had in the panel, in CSS pixels. Picture-in-picture takes its
 * shape from it: the page keeps this size out of sight, and its video fills the floating box.
 */
const sizes = new Map<string, { width: number; height: number }>();
export const fallbackPageSize = { width: 1280, height: 800 } as const;

export function rememberPageSize(threadId: string, width: number, height: number): void {
  if (width >= 100 && height >= 100)
    sizes.set(threadId, { width: Math.round(width), height: Math.round(height) });
}

export function pageSize(threadId: string): { width: number; height: number } {
  return sizes.get(threadId) ?? fallbackPageSize;
}
