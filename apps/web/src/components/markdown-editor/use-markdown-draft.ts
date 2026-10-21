import { useEffect, useEffectEvent, useRef, useState } from "react";
import { findDraft, putDraft, readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import * as z from "zod/mini";
import { useOptionalStorage } from "@/lib/layout.tsx";

/*
 * Unsent Markdown (a new issue, a comment on an issue or pull request) kept on this device
 * beside the thread composer's drafts, with the same bounded, most-recent-last list
 * (`putDraft`): the oldest fall off past the limit, an empty text removes its key.
 */
const storageKey = "ace.markdown.drafts";
const Entries = z.catch(
  z.array(
    z.tuple([
      z.string(),
      z.object({
        text: z.string(),
        mentions: z.array(z.string()),
        attachments: z.array(z.object({ sha256: z.string(), name: z.string() })),
      }),
    ]),
  ),
  [],
);
/** How long typing may pause before the draft is written; leaving writes it at once. */
const settleMs = 300;

function read(storage: KeyValueStorage | undefined, key: string): string | undefined {
  return findDraft(readJson(storage, storageKey, Entries, []), key)?.text;
}
function write(storage: KeyValueStorage | undefined, key: string, text: string) {
  // Each write reads the list again, so two windows writing different drafts keep both.
  const entries = readJson(storage, storageKey, Entries, []);
  writeJson(storage, storageKey, putDraft(entries, key, { text, mentions: [], attachments: [] }));
}

/**
 * Text for a Markdown field that survives leaving the page and coming back: read from this
 * device under `key` on mount, written once typing settles and at once on leave or when the
 * page is hidden. `clear(submitted)` empties it after a successful submit, unless more was
 * typed meanwhile (then it keeps the newer text and returns false). Without a key the text
 * lives only as long as the field.
 */
export function useMarkdownDraft(key: string | undefined, initial = "") {
  const storage = useOptionalStorage();
  const [text, setState] = useState(() => (key && read(storage, key)) || initial);
  const current = useRef(text);
  const pending = useRef(false);
  const flush = useEffectEvent(() => {
    if (!key || !pending.current) return;
    pending.current = false;
    write(storage, key, current.current);
  });
  useEffect(() => {
    if (!key || !pending.current) return;
    const timer = setTimeout(() => {
      pending.current = false;
      write(storage, key, text);
    }, settleMs);
    return () => clearTimeout(timer);
  }, [key, storage, text]);
  useEffect(() => {
    const hidden = () => flush();
    window.addEventListener("pagehide", hidden);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", hidden);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, []);
  const setText = (next: string) => {
    current.current = next;
    pending.current = true;
    setState(next);
  };
  const clear = (submitted?: string): boolean => {
    if (submitted !== undefined && current.current !== submitted) return false;
    current.current = "";
    pending.current = false;
    setState("");
    if (key) write(storage, key, "");
    return true;
  };
  return { text, setText, clear };
}

/** Draft keys, one per place text is written, so each keeps its own. */
export const draftKeys = {
  newIssueTitle: (project: string) => `issue:${project}:new:title`,
  newIssue: (project: string) => `issue:${project}:new`,
  issueComment: (project: string, number: number) => `issue:${project}:${number}:comment`,
  prComment: (project: string, pr: string) => `pr:${project}:${pr}:comment`,
};
