import type { SuitDetail } from "@ace/protocol/suits";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { part } from "@/lib/suit-part.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { useSuitLibrary } from "@/theme/suits/suit-library.tsx";
import { usePrepareReview, useMarketInstalled, type EntryKey } from "./market-api.ts";
import { suitFromReview } from "./market-looks.ts";
import { Shot } from "./market-window.tsx";

/*
 * Try it: the modal steps aside and the whole app wears the Suit through the Suit library's trial
 * (an installed Suit as installed, one not installed yet in its review's colours and fonts), with
 * a floating Undo and Keep it. Undo (or Esc) puts the person's own look back. Keep it wears an
 * installed Suit, and opens an uninstalled one's review, since nothing installs without one.
 */

export interface Trying {
  entry: EntryKey;
  title: string;
  publisher: string | undefined;
  suit: SuitDetail;
  /** The library id it is installed as, when it is. */
  installedAs: string | undefined;
}

export function useTryOn(onFailed: (message: string) => void) {
  const library = useSuitLibrary();
  const theme = useTheme();
  const prepare = usePrepareReview();
  const installed = useMarketInstalled().data?.installed;
  const [trying, setTrying] = useState<Trying>();
  const start = async (entry: EntryKey, title: string, publisher: string | undefined) => {
    const target = installed?.find(
      (item) => item.type === entry.type && item.name === entry.name && item.state === "on",
    )?.target;
    const listed = library.summaries?.find((summary) => summary.id === (target ?? entry.name));
    let suit = listed ? library.detail(listed) : undefined;
    if (listed && !suit) library.want(listed);
    if (!suit) {
      try {
        const held = await prepare(entry);
        suit = suitFromReview(held.review, held.items);
      } catch {
        suit = undefined;
      }
    }
    if (!suit) {
      onFailed("This look couldn't be tried on.");
      return;
    }
    library.tryOn(suit);
    setTrying({ entry, title, publisher, suit, installedAs: listed?.id });
  };
  const undo = () => {
    library.endTrial();
    setTrying(undefined);
  };
  /** Ends the trial; true when the Suit is now worn, false when it needs installing first. */
  const keep = (): boolean => {
    const was = trying;
    undo();
    if (!was?.installedAs) return false;
    theme.update({ suit: was.installedAs });
    return true;
  };
  return { trying, start, undo, keep };
}

export function TryBar(props: { trying: Trying | undefined; onUndo(): void; onKeep(): void }) {
  const scheme = useTheme().resolved.scheme;
  const { trying } = props;
  return (
    <div {...part("market-try")} className="mk-trybar" role="status" aria-live="polite">
      {trying && (
        <>
          <Shot suit={trying.suit} scheme={scheme} />
          <span className="mk-trybar-words">
            <b>Trying {trying.title}</b>
            {trying.publisher && <span>{trying.publisher}</span>}
          </span>
          <Button variant="secondary" size="lg" onClick={props.onUndo}>
            Undo
          </Button>
          <Button variant="primary" size="lg" onClick={props.onKeep}>
            Keep it
          </Button>
        </>
      )}
    </div>
  );
}
