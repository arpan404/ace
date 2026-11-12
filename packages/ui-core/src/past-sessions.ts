/*
 * What opening a past CLI session can say when it doesn't work, shared by the web's Past sessions
 * list and the phone's.
 */

/** Import reads a saved conversation into a thread; Continue also resumes it in its provider. */
export type PastSessionAction = "import" | "continue";

export const pastSessionProblems = {
  notImported:
    "This saved conversation couldn't be imported. Open it in its original app, then try again.",
  notContinued:
    "The conversation was imported, but couldn't continue. Use Import to read it, or check the provider in Settings.",
  notOpened: "The saved conversation couldn't be opened. Find past sessions again and retry.",
} as const;
