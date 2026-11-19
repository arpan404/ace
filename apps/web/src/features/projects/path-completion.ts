/**
 * Whether Tab in a location box's path has anything to do: complete the folder being typed, or
 * go into the highlighted folder. When it has nothing, Tab moves focus as usual. `names` are the
 * folders listed in the folder browsed, or undefined while none are listed yet (then Tab moves
 * on too). Folder names compare without case, as a person reads them.
 */
export function tabCompletes(options: {
  segment: string;
  names: readonly string[] | undefined;
  /** A folder is highlighted and something is typed after the slash. */
  intoHighlighted: boolean;
}): boolean {
  if (options.intoHighlighted) return true;
  // Nothing listed yet: Tab moves focus on rather than waiting on a read.
  if (options.names === undefined) return false;
  const typed = options.segment.toLowerCase();
  const candidates = options.names
    .map((name) => name.toLowerCase())
    .filter((name) => name.startsWith(typed));
  if (candidates.length === 0) return false;
  if (candidates.length === 1) return true;
  return sharedPrefix(candidates).length > typed.length;
}

function sharedPrefix(names: readonly string[]): string {
  return names.reduce((prefix, name) => {
    let at = 0;
    while (at < prefix.length && prefix[at] === name[at]) at += 1;
    return prefix.slice(0, at);
  });
}
