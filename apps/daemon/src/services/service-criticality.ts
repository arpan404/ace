/** What startup needs to know about a service to decide whether the daemon can do without it. */
export interface Criticality {
  name: string;
  essential?: boolean;
  requires: readonly string[];
}

/**
 * The services the daemon cannot run without: each essential one, and everything an essential
 * one requires, however indirectly. A required service that is missing degrades the essential
 * one, so the daemon stops just as if the essential service had failed (ADR 0175). Safe mode
 * never leaves these off, and their failure is never retried.
 */
export function criticalServices(order: readonly Criticality[]): ReadonlySet<string> {
  const byName = new Map(order.map((entry) => [entry.name, entry]));
  const critical = new Set<string>();
  const visit = (name: string) => {
    if (critical.has(name)) return;
    critical.add(name);
    for (const dependency of byName.get(name)?.requires ?? []) visit(dependency);
  };
  for (const entry of order) if (entry.essential) visit(entry.name);
  return critical;
}
