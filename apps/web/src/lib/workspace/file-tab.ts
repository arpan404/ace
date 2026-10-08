/** File tab identity shared by the registry and producers that open a saved path. */
export const fileTabId = (path: string) => `file:${path}`;
export const fileTab = (path: string) => ({ kind: "files", id: fileTabId(path), data: { path } });
