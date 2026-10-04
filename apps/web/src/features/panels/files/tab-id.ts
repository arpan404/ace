/** The tab id of a checkout file: one tab per path, never equal to the kind (the empty tab). */
export const fileTabId = (path: string) => `file:${path}`;

/** A checkout file's tab, kept (not a preview): what the summary's Sources open. */
export const fileTab = (path: string) => ({
  kind: "files",
  id: fileTabId(path),
  data: { path },
});
