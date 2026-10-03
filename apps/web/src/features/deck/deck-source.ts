// TODO(train-2): wire to protocol when merged
/*
 * The one boundary between the Deck screens and the daemon. Commands are the real
 * `conductor.*` payloads from @ace/protocol; the run view is not on the wire yet, so runs
 * come from the fake conductor in fake mode and are unavailable against a real daemon.
 */
import { ConductorCommandPayload } from "@ace/protocol";
import { useMemo, useSyncExternalStore } from "react";
import { UnavailableError, useFakeBackend, type FakeBackend } from "@/boot/fake-backend.ts";
import { type DeckRun } from "@ace/ui-core";

export interface DeckSource {
  /** False until the first list arrives; screens show nothing rather than "no decks". */
  ready(): boolean;
  runs(): readonly DeckRun[];
  subscribe(listener: () => void): () => void;
  send(payload: ConductorCommandPayload): Promise<void>;
}

export class DeckCommandError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(
      code === "stale_gate"
        ? "That decision is out of date. The deck has moved on."
        : `The deck refused the command (${code}).`,
    );
    this.code = code;
  }
}

const empty: readonly DeckRun[] = [];

function fakeDeckSource(backend: Promise<FakeBackend>): DeckSource {
  let loaded: FakeBackend | undefined;
  const listeners = new Set<() => void>();
  void backend.then((value) => {
    loaded = value;
    value.conductor.subscribe(() => listeners.forEach((listener) => listener()));
    listeners.forEach((listener) => listener());
  });
  return {
    ready: () => loaded !== undefined,
    // The fake run view has the model's shape, so the compiler checks the mapping.
    runs: (): readonly DeckRun[] => loaded?.conductor.runs() ?? empty,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(payload) {
      const result = (await backend).conductor.command(ConductorCommandPayload.parse(payload));
      if (!result.ok) throw new DeckCommandError(result.error);
    },
  };
}

const unavailable: DeckSource = {
  ready: () => true,
  runs: () => empty,
  subscribe: () => () => {},
  send: () => Promise.reject(new UnavailableError("Decks")),
};

const sources = new WeakMap<Promise<FakeBackend>, DeckSource>();

export function useDeckSource(): DeckSource {
  const backend = useFakeBackend();
  return useMemo(() => {
    if (!backend) return unavailable;
    let source = sources.get(backend);
    if (!source) {
      source = fakeDeckSource(backend);
      sources.set(backend, source);
    }
    return source;
  }, [backend]);
}

export function useDeckRuns(): { ready: boolean; runs: readonly DeckRun[] } {
  const source = useDeckSource();
  const runs = useSyncExternalStore(source.subscribe, source.runs, source.runs);
  const ready = useSyncExternalStore(source.subscribe, source.ready, source.ready);
  return { ready, runs };
}

export function useDeckRun(id: string): { ready: boolean; run: DeckRun | undefined } {
  const { ready, runs } = useDeckRuns();
  return { ready, run: runs.find((run) => run.id === id) };
}
