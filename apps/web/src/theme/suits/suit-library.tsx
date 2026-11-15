import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ClientApi } from "@ace/client";
import type { SuitDetail, SuitId, SuitSummary } from "@ace/protocol/suits";
import { wantedSuit } from "./applied-suit.ts";
import { useTheme } from "../theme-provider.tsx";
import { daemonSuitChannel, suitTransport, type SuitTransport } from "./suit-transport.ts";

/*
 * The daemon's Suit library on this page (ADR 0150): one subscription to the list, and each
 * Suit's detail read once per version. It tells the theme provider what it knows, so the Suit
 * this device picked applies as soon as it is listed with no problems and read.
 */

interface Library {
  /** Undefined until the daemon has answered. */
  summaries: readonly SuitSummary[] | undefined;
  /** The list couldn't be read; Suits show as none and the theme applies. */
  failed: boolean;
  detail(summary: SuitSummary): SuitDetail | undefined;
  /** Read `summary`'s detail if it isn't read yet. */
  want(summary: SuitSummary): void;
  /** An agent's preview on top of the device setting; undefined when none runs. */
  preview: SuitId | null | undefined;
  /** The daemon channel, for the live check's `suitCheck` and `suitReport`. */
  transport: SuitTransport | undefined;
}
const LibraryContext = createContext<Library | undefined>(undefined);

const noSuits: readonly SuitSummary[] = [];

const versionKey = (summary: SuitSummary) => `${summary.id}\u0000${summary.contentHash}`;

/**
 * The transport for this client; tests pass their own. `origin` is the daemon's HTTP origin
 * when this page may dial it, for the Suit's scene and fonts.
 */
export function suitTransportFor(client: ClientApi, origin: string | undefined): SuitTransport {
  return suitTransport(daemonSuitChannel(client, origin));
}

/** A read detail and the socket it was read over; its URLs work only for that socket's run. */
interface Read {
  detail: SuitDetail;
  socket: number | undefined;
}

export function SuitLibraryProvider(props: {
  transport: SuitTransport | undefined;
  children: ReactNode;
}) {
  const { transport } = props;
  const { appearance, update, reportSuits } = useTheme();
  const [preview, setPreview] = useState<SuitId | null | undefined>(undefined);
  const [heard, setHeard] = useState<readonly SuitSummary[] | undefined>(undefined);
  // With no channel to the daemon there are no Suits, and the theme shows.
  const summaries = transport ? heard : noSuits;
  const [failed, setFailed] = useState(false);
  const [details, setDetails] = useState<ReadonlyMap<string, Read>>(new Map());
  // The daemon socket the list last came over: a detail read over an older one is read again.
  const [socket, setSocket] = useState<number | undefined>(undefined);
  const [wanted, setWanted] = useState<ReadonlySet<string>>(new Set());

  // Each version is read once; a read in flight is never started twice.
  const reading = useRef(new Set<string>());
  useEffect(() => {
    reading.current = new Set();
    if (!transport) return;
    return transport.watch(
      (suits, over) => {
        setFailed(false);
        setHeard(suits);
        setSocket(over);
      },
      () => {
        setFailed(true);
        setHeard((known) => known ?? noSuits);
      },
    );
  }, [transport]);

  const want = useCallback((summary: SuitSummary) => {
    const key = versionKey(summary);
    setWanted((known) => (known.has(key) ? known : new Set(known).add(key)));
  }, []);

  // An agent's preview shows until it ends; a keep becomes this device's setting, and its undo
  // puts back what this device had, which only this device knows.
  const setting = useRef(appearance.suit);
  useEffect(() => {
    setting.current = appearance.suit;
  }, [appearance.suit]);
  const undos = useRef(new Map<string, { kept: SuitId; before: SuitId | null }>());
  useEffect(() => {
    if (!transport) return;
    return transport.watchActive((active) => {
      switch (active.kind) {
        case "preview":
          setPreview(active.suitId);
          return;
        case "none":
          setPreview(undefined);
          return;
        case "keep":
          setPreview(undefined);
          undos.current.set(active.keepId, { kept: active.suitId, before: setting.current });
          update({ suit: active.suitId });
          return;
        case "restore": {
          const undo = undos.current.get(active.keepId);
          undos.current.delete(active.keepId);
          // The person picked something else since: theirs stays.
          if (undo && setting.current === undo.kept) update({ suit: undo.before });
          return;
        }
      }
    });
  }, [transport, update]);

  // The wanted Suit is always read; Settings asks for the rest to draw their swatches.
  const wantedId = wantedSuit(appearance.suit, preview);
  const picked = summaries?.find((summary) => summary.id === wantedId);
  const pickedKey = picked ? versionKey(picked) : undefined;
  const toRead = useMemo(() => {
    const keys = new Set(wanted);
    if (pickedKey) keys.add(pickedKey);
    return [...keys].filter((key) => {
      const read = details.get(key);
      return !read || read.socket !== socket;
    });
  }, [wanted, pickedKey, details, socket]);

  // Reads over an older socket are dropped as they land; their URLs are dead.
  const readsOver = useRef(socket);
  useEffect(() => {
    if (readsOver.current !== socket) {
      readsOver.current = socket;
      reading.current = new Set();
    }
    if (!transport || !summaries) return;
    for (const key of toRead) {
      const summary = summaries.find((entry) => versionKey(entry) === key);
      if (!summary || reading.current.has(key)) continue;
      const inFlight = reading.current;
      inFlight.add(key);
      transport.read(summary.id).then(
        (detail) => {
          if (reading.current !== inFlight) return;
          setDetails((known) => new Map(known).set(versionKey(detail.summary), { detail, socket }));
        },
        () => {
          // An unreadable Suit stays unapplied; a new version in the list is read afresh.
        },
      );
    }
  }, [transport, summaries, toRead, socket]);

  // Until a detail is read again over a new socket, the older read keeps the look on screen.
  const pickedDetail = pickedKey ? details.get(pickedKey)?.detail : undefined;
  useEffect(() => {
    reportSuits({ summaries, detail: pickedDetail, preview });
  }, [reportSuits, summaries, pickedDetail, preview]);

  const value = useMemo<Library>(
    () => ({
      summaries,
      failed,
      detail: (summary) => details.get(versionKey(summary))?.detail,
      want,
      preview,
      transport,
    }),
    [summaries, failed, details, want, preview, transport],
  );
  return <LibraryContext.Provider value={value}>{props.children}</LibraryContext.Provider>;
}

/** Outside a daemon's tree (the connection screen, a story): no Suits. */
const noLibrary: Library = {
  summaries: [],
  failed: false,
  detail: () => undefined,
  want: () => {},
  preview: undefined,
  transport: undefined,
};

export function useSuitLibrary(): Library {
  return useContext(LibraryContext) ?? noLibrary;
}

/** One Suit's detail, read when first asked for. */
export function useSuitDetail(summary: SuitSummary): SuitDetail | undefined {
  const library = useSuitLibrary();
  const { want } = library;
  useEffect(() => want(summary), [want, summary]);
  return library.detail(summary);
}
