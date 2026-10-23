import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type { LineRange } from "@/features/panels/index.ts";
import { nextFrame } from "@/lib/next-frame.ts";

/** Values by key, where a change to one key wakes only that key's readers. */
class Keyed<V> {
  readonly #values = new Map<string, V>();
  readonly #listeners = new Map<string, Set<() => void>>();
  get(key: string): V | undefined {
    return this.#values.get(key);
  }
  set(key: string, value: V | undefined) {
    if (value === undefined) {
      if (!this.#values.delete(key)) return;
    } else if (this.#values.get(key) === value) return;
    else this.#values.set(key, value);
    for (const listener of this.#listeners.get(key) ?? []) listener();
  }
  /** Clears `key` only while it still holds `value`: what was saved, not what came after. */
  clearIf(key: string, value: V) {
    if (this.#values.get(key) === value) this.set(key, undefined);
  }
  subscribe(key: string, listener: () => void): () => void {
    const set = this.#listeners.get(key) ?? new Set();
    set.add(listener);
    this.#listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.#listeners.delete(key);
    };
  }
}

/**
 * Lines picked for a new comment, with the head and commit view they were picked on. A pick is
 * about those lines of that version only: after a push the same numbers name other code.
 */
export interface LinePick {
  headSha: string;
  /** The single commit shown, or "" for All commits. */
  commit: string;
  range: LineRange;
}

/** A comment's text being edited, with the text it replaces (the write's guard). */
export interface CommentEdit {
  body: string;
  expectedBody: string;
}

/**
 * What the person is doing in a pull request's comments, kept above the rows that show it. Long
 * diffs and timelines mount only the rows near the viewport, so a row's own state would vanish
 * when it scrolls away; here it survives, and a row coming back doesn't take focus again.
 */
interface PrUiState {
  /** Per file path: the lines a new comment is being written on, and the version picked on. */
  picks: Keyed<LinePick>;
  /** Per comment (`issue:7`, `inline:5`, `draft:<id>`): its text being edited. */
  edits: Keyed<CommentEdit>;
  /** Per reply field (`<thread id>`, `attention:<thread id>`): open. */
  replies: Keyed<true>;
  /** Per text box: focus the person's last action asked for, taken once by that box. */
  focus: Keyed<true>;
  /** Per conversation: opened or folded by the person, while it stayed (un)resolved. */
  folds: Keyed<{ open: boolean; resolved: boolean }>;
}
const createState = (): PrUiState => ({
  picks: new Keyed(),
  edits: new Keyed(),
  replies: new Keyed(),
  focus: new Keyed(),
  folds: new Keyed(),
});

const Context = createContext<PrUiState | null>(null);

export function PrUiProvider(props: { children: ReactNode }) {
  const [state] = useState(createState);
  return <Context value={state}>{props.children}</Context>;
}

function useStore(): PrUiState {
  // Outside a pull request (a lone component in a test), state lives as long as the component.
  const [own] = useState(createState);
  return useContext(Context) ?? own;
}

function useKeyed<V>(
  pick: (state: PrUiState) => Keyed<V>,
  key: string,
): [V | undefined, (value: V | undefined) => void, (value: V) => void] {
  const store = pick(useStore());
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(key, listener),
    [store, key],
  );
  const value = useSyncExternalStore(subscribe, () => store.get(key));
  const set = useCallback((next: V | undefined) => store.set(key, next), [store, key]);
  const clearIf = useCallback((sent: V) => store.clearIf(key, sent), [store, key]);
  return [value, set, clearIf];
}

/** The lines a new comment on `path` is being written on. */
export const usePick = (path: string) => useKeyed((s) => s.picks, path);
/** A comment's edit in progress; `key` names the comment (`issue:7`, `draft:<id>`). */
export const useEdit = (key: string) => useKeyed((s) => s.edits, key);
/** A conversation's fold the person chose, and whether it was resolved when they chose it. */
export const useFold = (threadId: string) => useKeyed((s) => s.folds, threadId);
/** Whether a reply field is open. */
export const useReplyOpen = (key: string) => useKeyed((s) => s.replies, key);

/**
 * Focus for the text box in `box`, named `id`: `ask()` (from the person's own action) focuses
 * it on the next frame with the caret at the end. A box that mounts again later, scrolled back
 * into view, finds nothing asked and leaves focus where it is.
 */
export function useFocusAsk(id: string, box: RefObject<HTMLElement | null>): () => void {
  const [asked, setAsked] = useKeyed((s) => s.focus, id);
  useEffect(() => {
    if (!asked) return;
    return nextFrame(() => {
      setAsked(undefined);
      const field = box.current?.querySelector("textarea");
      if (!field) return;
      // Centred, so pinned bars above the scroller never cover it.
      field.scrollIntoView?.({ block: "center" });
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }, [asked, setAsked, box]);
  return useCallback(() => setAsked(true), [setAsked]);
}

/** Asks for focus on another box (`useFocusAsk`), from where the action happened. */
export function useAskFocus(): (id: string) => void {
  const store = useStore();
  return useCallback((id: string) => store.focus.set(id, true), [store]);
}
