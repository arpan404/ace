/** The tab id of a checkout file: one tab per path, never equal to the kind (the empty tab). */
export const fileTabId = (path: string) => `file:${path}`;
