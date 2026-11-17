import type { MarketMe } from "@ace/protocol/marketplace";
import { MarketEntryName } from "@ace/protocol/marketplace";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { typeWord } from "./market-model.ts";
import { Foot, keyOf, Steps } from "./market-publish-parts.tsx";
import {
  standing,
  useOwnSuits,
  type MarketPublishItem,
  type MarketPublishType,
} from "./market-publish-port.ts";
import { Stage } from "./market-stage.tsx";

/*
 * The Item step: which one. A look is one of the person's own Suits, read from their library by
 * id. A bot, skill or plugin is a folder on this machine, under a name: a new entry, or a new
 * version of one they already published.
 */

function SuitChoices(props: {
  me: MarketMe | undefined;
  chosen: MarketPublishItem | undefined;
  onChoose(item: MarketPublishItem): void;
}) {
  const suits = useOwnSuits(props.me);
  if (!suits.length) return <p className="mk-line">You haven't made a Suit yet.</p>;
  return (
    <div className="mk-cards" data-cols="3" data-phone="grid" style={{ marginTop: 32 }}>
      {suits.map((each) => (
        <button
          key={each.name}
          type="button"
          className="mk-choice"
          aria-pressed={props.chosen?.name === each.name}
          onClick={() => props.onChoose(each)}
        >
          <Stage entry={keyOf(each)} size="card" />
          <span className="mk-card-words">
            <span className="mk-name">{each.title}</span>
            <span className="mk-meta">{each.state}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function FolderChoice(props: {
  type: MarketPublishType;
  me: MarketMe | undefined;
  onChoose(item: MarketPublishItem | undefined): void;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const mine = props.me?.entries.filter((entry) => entry.type === props.type) ?? [];
  const update = (nextName: string, nextPath: string) => {
    setName(nextName);
    setPath(nextPath);
    const ready = MarketEntryName.safeParse(nextName).success && nextPath.trim().length > 1;
    props.onChoose(
      ready
        ? {
            type: props.type,
            name: nextName,
            title: mine.find((entry) => entry.name === nextName)?.title ?? nextName,
            line: mine.find((entry) => entry.name === nextName)?.line ?? "",
            source: { kind: "folder", path: nextPath.trim() },
            ...standing(props.me, props.type, nextName),
          }
        : undefined,
    );
  };
  return (
    <div className="mk-form" style={{ marginTop: 32, maxWidth: 560 }}>
      {mine.length > 0 && (
        <div>
          <span className="mk-label">A new version of</span>
          <div className="mk-chips">
            {mine.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className="mk-chip"
                aria-pressed={name === entry.name}
                onClick={() => update(entry.name, path)}
              >
                {entry.title}
              </button>
            ))}
          </div>
        </div>
      )}
      <div>
        <label className="mk-label" htmlFor="mk-pub-entry">
          Name in the marketplace
        </label>
        <input
          id="mk-pub-entry"
          className="mk-field"
          value={name}
          autoComplete="off"
          placeholder="triage-mail"
          onChange={(event) => update(event.target.value.toLowerCase(), path)}
        />
      </div>
      <div>
        <label className="mk-label" htmlFor="mk-pub-folder">
          Folder on this machine
        </label>
        <input
          id="mk-pub-folder"
          className="mk-field"
          value={path}
          autoComplete="off"
          placeholder="/Users/you/skills/triage-mail"
          onChange={(event) => update(name, event.target.value)}
        />
      </div>
    </div>
  );
}

export function ChooseItem(props: {
  type: MarketPublishType;
  me: MarketMe | undefined;
  now: number;
  chosen: MarketPublishItem | undefined;
  onChoose(item: MarketPublishItem | undefined): void;
  onBack(): void;
  onNext(item: MarketPublishItem): void;
}) {
  const { type, chosen } = props;
  return (
    <div className="mk-inner" data-width="form">
      <Steps now={props.now} />
      <h1 className="mk-display-sm">
        Which {type === "suit" ? "Suit" : typeWord(type).toLowerCase()}?
      </h1>
      {type === "suit" ? (
        <SuitChoices me={props.me} chosen={chosen} onChoose={props.onChoose} />
      ) : (
        <FolderChoice type={type} me={props.me} onChoose={props.onChoose} />
      )}
      <Foot>
        <Button variant="ghost" size="lg" onClick={props.onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={!chosen}
          onClick={() => chosen && props.onNext(chosen)}
        >
          Next
        </Button>
      </Foot>
    </div>
  );
}
