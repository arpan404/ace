import type {
  MarketOwnEntry,
  MarketOwnVersion,
  MarketPublishAction,
} from "@ace/protocol/marketplace";
import { MarketEntryType, MarketPublisherName } from "@ace/protocol/marketplace";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Empty, Section } from "./market-card.tsx";
import { ListingEditor } from "./market-manage-listing.tsx";
import { SignalsSection } from "./market-manage-signals.tsx";
import { dateText, failureSentence, findingSentences, typeWord } from "./market-model.ts";
import { useMarketNav } from "./market-nav.ts";
import { VersionState } from "./market-profile.tsx";
import { useOwnEntry, usePublishAction } from "./market-publishing.ts";
import { Stage } from "./market-stage.tsx";

/*
 * Managing one of your entries (ADR 0174 §5): its listing's words, every version with its state
 * (which one the listing shows, and going back to an older one), deprecating, withdrawing (asked
 * twice), appeals, unlisted and archived, handing it to another publisher, and its signals.
 * Each change is one publish action; what the market says back is shown in a sentence.
 */

/** What an inline question on this page is asking. */
/** A publish action on this entry, before the entry's type and name are added. */
type EntryAction =
  Extract<MarketPublishAction, { type: unknown }> extends infer A
    ? A extends unknown
      ? Omit<A, "type" | "name">
      : never
    : never;

type Asking =
  | { kind: "withdraw"; version?: string | undefined }
  | { kind: "deprecate"; version: string }
  | { kind: "appeal"; version: string };

const asks = {
  withdraw: {
    field: "Why you're withdrawing it",
    confirm: "Withdraw",
    line: "Installs of it turn off on every machine, and it can't be installed again.",
  },
  deprecate: {
    field: "A note for people who have it",
    confirm: "Deprecate",
    line: "It stays installable; installs show your note.",
  },
  appeal: {
    field: "What changed, or why it should be listed",
    confirm: "Send appeal",
    line: "A maintainer reads it and answers here.",
  },
} as const;

function Ask(props: {
  asking: Asking;
  pending: boolean;
  onCancel(): void;
  onConfirm(text: string): void;
}) {
  const [text, setText] = useState("");
  const words = asks[props.asking.kind];
  const what =
    props.asking.kind === "withdraw" && !props.asking.version
      ? "every version"
      : props.asking.version;
  return (
    <div role="group" aria-label={`${words.confirm} ${what}`} className="mk-ask">
      <p className="mk-name" style={{ margin: 0 }}>
        {words.confirm} {what}?
      </p>
      <p className="mk-line" style={{ margin: 0 }}>
        {words.line}
      </p>
      <label className="mk-label" htmlFor="mk-ask-text">
        {words.field}
      </label>
      <textarea
        id="mk-ask-text"
        className="mk-field"
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="mk-actions">
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          tone={props.asking.kind === "withdraw" ? "danger" : undefined}
          size="sm"
          disabled={!text.trim() || props.pending}
          onClick={() => props.onConfirm(text.trim())}
        >
          {words.confirm}
        </Button>
      </div>
    </div>
  );
}

function VersionRow(props: {
  version: MarketOwnVersion;
  latest: boolean;
  onAct(request: EntryAction): void;
  onAsk(asking: Asking): void;
}) {
  const { version } = props;
  const live = version.status === "live" || version.status === "not-reviewed";
  const appealable = version.status === "blocked" || (version.status === "waiting" && version.held);
  return (
    <div className="mk-mine-row" aria-label={`Version ${version.version}`} role="listitem">
      <span className="mk-v" style={{ fontVariantNumeric: "tabular-nums" }}>
        {version.version}
      </span>
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <VersionState version={version} />
          {props.latest && <span className="mk-meta">The listing shows this one</span>}
          <span className="mk-meta">
            {dateText(version.published)} · {version.downloads.toLocaleString("en-US")} downloads
          </span>
        </span>
        {version.reason && <span className="mk-withdrawn-line">{version.reason}</span>}
        {version.deprecated && <span className="mk-line">Deprecated: {version.deprecated}</span>}
        {version.status === "blocked" &&
          findingSentences(version.scan).map((found) => (
            <span key={found} className="mk-why">
              {found}
            </span>
          ))}
        {version.appeal && (
          <span className="mk-line">
            {version.appeal.state === "open"
              ? "Your appeal waits for a maintainer."
              : version.appeal.state === "approved"
                ? "Your appeal was approved."
                : "Your appeal was answered: it stays as it is."}
            {version.appeal.answer ? ` ${version.appeal.answer}` : ""}
          </span>
        )}
      </div>
      <div className="mk-actions">
        {live && !props.latest && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => props.onAct({ action: "latest", version: version.version })}
          >
            Make latest
          </Button>
        )}
        {live &&
          (version.deprecated ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                props.onAct({ action: "deprecate", version: version.version, note: null })
              }
            >
              Undeprecate
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => props.onAsk({ kind: "deprecate", version: version.version })}
            >
              Deprecate
            </Button>
          ))}
        {live && (
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            onClick={() => props.onAsk({ kind: "withdraw", version: version.version })}
          >
            Withdraw
          </Button>
        )}
        {appealable && !version.appeal && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => props.onAsk({ kind: "appeal", version: version.version })}
          >
            Appeal
          </Button>
        )}
      </div>
    </div>
  );
}

function Manage(props: { entry: MarketOwnEntry }) {
  const nav = useMarketNav();
  const { entry } = props;
  const { summary } = entry;
  const key = { type: summary.type, name: summary.name };
  const action = usePublishAction();
  const [asking, setAsking] = useState<Asking>();
  const [said, setSaid] = useState<string>();
  const [handle, setHandle] = useState("");
  const live = entry.versions.filter((v) => v.status === "live" || v.status === "not-reviewed");
  const shown = entry.latest ?? live[0]?.version;
  const send = (request: MarketPublishAction, done?: string) => {
    setSaid(undefined);
    action.mutate(request, {
      onSuccess: (answer) => {
        setAsking(undefined);
        if (answer.kind === "pending")
          setSaid(
            answer.what === "withdrawal"
              ? "Withdrawn. It leaves every machine once ace signs the withdrawal."
              : "Your edit waits for a maintainer before it shows.",
          );
        else if (done) setSaid(done);
      },
      onError: (error) => setSaid(failureSentence(error, "change")),
    });
  };
  // Each version's action carries the entry it's on.
  const act = (request: EntryAction) => send({ ...key, ...request });
  return (
    <div className="mk-inner" data-width="read">
      <div className="mk-check-summary">
        <Stage
          entry={{ source: "market", ...key, previews: entry.listing.previews }}
          size="small"
        />
        <div style={{ display: "grid", gap: 4 }}>
          <h1 className="mk-display-sm">{summary.title}</h1>
          <span className="mk-line">
            {[
              typeWord(summary.type),
              summary.visibility === "unlisted" ? "Unlisted" : "Listed",
              summary.archived ? "Archived" : undefined,
              `${summary.downloads.toLocaleString("en-US")} downloads`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      </div>
      {said && (
        <p role="status" className="mk-line" style={{ marginTop: 16 }}>
          {said}
        </p>
      )}
      <Section title="Versions">
        <div role="list" aria-label="Versions">
          {entry.versions.map((version) => (
            <VersionRow
              key={version.version}
              version={version}
              latest={version.version === shown}
              onAct={act}
              onAsk={setAsking}
            />
          ))}
        </div>
        {entry.latest && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => act({ action: "latest", version: null })}
          >
            Show the newest version again
          </Button>
        )}
        {asking && (
          <Ask
            key={`${asking.kind}:${"version" in asking ? asking.version : ""}`}
            asking={asking}
            pending={action.isPending}
            onCancel={() => setAsking(undefined)}
            onConfirm={(text) =>
              asking.kind === "withdraw"
                ? act({
                    action: "withdraw",
                    ...(asking.version ? { version: asking.version } : {}),
                    reason: text,
                  })
                : asking.kind === "deprecate"
                  ? act({ action: "deprecate", version: asking.version, note: text })
                  : act({ action: "appeal", version: asking.version, note: text })
            }
          />
        )}
      </Section>
      <ListingEditor
        entry={entry}
        pending={action.isPending}
        onSave={(listing) => act({ action: "listing", listing })}
      />
      <Section title="Who can find it">
        <div className="mk-word-choice" role="group" aria-label="Visibility">
          {(["listed", "unlisted"] as const).map((visibility) => (
            <button
              key={visibility}
              type="button"
              aria-pressed={summary.visibility === visibility}
              onClick={() =>
                summary.visibility !== visibility && act({ action: "visibility", visibility })
              }
            >
              {visibility === "listed" ? "Listed" : "Unlisted"}
            </button>
          ))}
        </div>
        <p className="mk-line">
          {summary.visibility === "unlisted"
            ? "Only people with its link find it; search and Discover leave it out."
            : "Anyone finds it in search and Discover."}
        </p>
        <div className="mk-actions" style={{ justifyContent: "flex-start" }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => act({ action: "archive", archived: !summary.archived })}
          >
            {summary.archived ? "Unarchive" : "Archive"}
          </Button>
          {live.length > 0 && (
            <Button
              variant="ghost"
              tone="danger"
              size="sm"
              onClick={() => setAsking({ kind: "withdraw" })}
            >
              Withdraw every version
            </Button>
          )}
        </div>
      </Section>
      <Section title="Hand it to another publisher">
        <div style={{ display: "flex", gap: 8, alignItems: "end", maxWidth: 480 }}>
          <div style={{ flex: 1 }}>
            <label className="mk-label" htmlFor="mk-transfer">
              Their handle
            </label>
            <input
              id="mk-transfer"
              className="mk-field"
              value={handle}
              autoComplete="off"
              onChange={(event) => setHandle(event.target.value.toLowerCase())}
            />
          </div>
          <Button
            variant="secondary"
            disabled={!MarketPublisherName.safeParse(handle).success || action.isPending}
            onClick={() => act({ action: "transfer", to: handle })}
          >
            Offer it
          </Button>
        </div>
        <p className="mk-line">It moves once they accept, within a week.</p>
      </Section>
      <SignalsSection type={summary.type} name={summary.name} />
      <div style={{ marginTop: 40 }}>
        <Button
          variant="ghost"
          size="sm"
          disabled={!live.length || summary.visibility === "unlisted"}
          onClick={() => nav.push({ kind: "entry", entry: { source: "market", ...key } })}
        >
          Open its page
        </Button>
      </div>
    </div>
  );
}

export function ManagePage(props: { type: string; name: string }) {
  const type = MarketEntryType.safeParse(props.type);
  if (!type.success) return <Empty title="This entry can't be managed here" />;
  return <ManageLoaded type={type.data} name={props.name} />;
}

function ManageLoaded(props: { type: MarketEntryType; name: string }) {
  const query = useOwnEntry(props.type, props.name);
  if (query.isError && !query.data) return <Empty title={failureSentence(query.error, "read")} />;
  if (!query.data) return null;
  return <Manage entry={query.data} />;
}

export function ManageCrumb(props: { type: string; name: string }) {
  const type = MarketEntryType.safeParse(props.type);
  const entry = useOwnEntry(type.success ? type.data : "suit", props.name).data;
  return <>{entry?.summary.title ?? props.name}</>;
}
