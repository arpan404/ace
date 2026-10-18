/** What the page reported under the pointer, and what the tab can do now. */
export interface ContextFacts {
  linkURL: string;
  srcURL: string;
  mediaType: string;
  hasImageContents: boolean;
  selectionText: string;
  isEditable: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type ContextCommand =
  | "back"
  | "forward"
  | "reload"
  | "openLink"
  | "copyLink"
  | "cut"
  | "copy"
  | "paste"
  | "copyImage"
  | "copyImageAddress"
  | "saveImage"
  | "annotate"
  | "viewSource"
  | "inspect";

export interface ContextEntry {
  command: ContextCommand;
  label: string;
  enabled: boolean;
}

const web = (url: string) => /^https?:\/\//i.test(url);
const entry = (command: ContextCommand, label: string, enabled = true): ContextEntry => ({
  command,
  label,
  enabled,
});

/**
 * The page's context menu, grouped like a browser's: what was clicked (link, image, text or a
 * field) first, then page navigation, then ace's own tools. Pure, so the grouping is tested
 * without Electron.
 */
export function contextEntries(facts: ContextFacts): (ContextEntry | "separator")[] {
  const groups: ContextEntry[][] = [];
  if (facts.linkURL)
    groups.push([
      entry("openLink", "Open link in new tab", web(facts.linkURL)),
      entry("copyLink", "Copy link address"),
    ]);
  const image = facts.mediaType === "image" && facts.srcURL !== "";
  if (image)
    groups.push([
      entry("copyImage", "Copy image", facts.hasImageContents),
      entry("copyImageAddress", "Copy image address"),
      entry("saveImage", "Save image as…", web(facts.srcURL)),
    ]);
  if (facts.isEditable)
    groups.push([
      entry("cut", "Cut", facts.canCut),
      entry("copy", "Copy", facts.canCopy),
      entry("paste", "Paste", facts.canPaste),
    ]);
  else if (facts.selectionText.trim()) groups.push([entry("copy", "Copy", facts.canCopy)]);
  if (!facts.linkURL && !image && !facts.isEditable && !facts.selectionText.trim())
    groups.push([
      entry("back", "Back", facts.canGoBack),
      entry("forward", "Forward", facts.canGoForward),
      entry("reload", "Reload"),
    ]);
  groups.push([entry("annotate", "Annotate this element")]);
  groups.push([entry("viewSource", "View page source"), entry("inspect", "Inspect")]);
  const entries: (ContextEntry | "separator")[] = [];
  for (const group of groups) {
    if (entries.length) entries.push("separator");
    entries.push(...group);
  }
  return entries;
}
