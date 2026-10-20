/**
 * Whether a native tab's sound is off. The tab the person is shown plays, unless an agent is
 * using it; background tabs and agents' tabs are muted. Once the person turns a tab's sound
 * off or on themselves, that choice holds for the tab.
 */
export function audioMuted(tab: {
  shown: boolean;
  agentControl: boolean;
  chosen?: boolean | undefined;
}): boolean {
  return tab.chosen ?? (!tab.shown || tab.agentControl);
}
