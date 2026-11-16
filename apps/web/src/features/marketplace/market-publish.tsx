import { CheckCircleIcon, WarningCircleIcon } from "@ace/icons";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "./market-card.tsx";
import {
  useMarketPublishPort,
  type MarketCheckView,
  type MarketListingDraft,
  type MarketPublishItem,
  type MarketPublishPort,
  type MarketPublishType,
} from "./market-later.ts";
import { Empty } from "./market-card.tsx";
import { typeWord } from "./market-model.ts";
import { Status } from "./market-marks.tsx";
import { useMarketNav } from "./market-nav.ts";
import { Stage } from "./market-stage.tsx";

/*
 * Publishing (ADR 0173 §2): what you're publishing, which one, ace's checks on its files, then
 * its listing, and it waits for review. Each step has its own page under the same steps line and
 * a sticky foot. It runs over the daemon's publish actions (`MarketPublishPort`).
 */

const steps = ["Type", "Item", "Check", "Describe"] as const;
type Step = (typeof steps)[number] | "done";

const choices: readonly { type: MarketPublishType; name: string; line: string }[] = [
  { type: "suit", name: "Look", line: "A Suit: colours, fonts and a picture." },
  { type: "spade-bot", name: "Bot", line: "A recipe: face, task, routines and the apps it needs." },
  { type: "spade-skill", name: "Skill", line: "Instructions and scripts a bot can use." },
  { type: "spade-plugin", name: "Plugin", line: "Commands and tools for agents and bots." },
];

function Steps(props: { now: number }) {
  return (
    <div className="mk-steps" aria-label={`Step ${props.now + 1} of 4`}>
      {steps.map((step, at) => (
        <Fragment key={step}>
          {at > 0 && <i />}
          <span data-step={at < props.now ? "done" : at === props.now ? "now" : undefined}>
            <b>{at + 1}</b>
            <span className="mk-label-word">{step}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function Foot(props: { left?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mk-foot">
      <div className="mk-foot-inner">
        <span className="mk-grow">{props.left}</span>
        {props.children}
      </div>
    </div>
  );
}

const keyOf = (item: Pick<MarketPublishItem, "type" | "name">) => ({
  source: "market",
  type: item.type,
  name: item.name,
});

export function PublishPage() {
  const port = useMarketPublishPort();
  if (!port) return <Empty title="Publishing isn't available on this machine yet" />;
  return <PublishFlow port={port} />;
}

export function PublishFlow(props: { port: MarketPublishPort }) {
  const nav = useMarketNav();
  const { port } = props;
  const [step, setStep] = useState<Step>("Type");
  const [type, setType] = useState<MarketPublishType>();
  const [item, setItem] = useState<MarketPublishItem>();
  const [checks, setChecks] = useState<readonly MarketCheckView[]>();
  const [listing, setListing] = useState<MarketListingDraft>();
  const [failed, setFailed] = useState<string>();
  const runChecks = (chosen: MarketPublishItem) => {
    setChecks(undefined);
    port.check(chosen).then(setChecks, () => setFailed("ace couldn't check it. Try again."));
  };
  const now = step === "done" ? 4 : steps.indexOf(step);
  if (step === "done" && item)
    return (
      <div className="mk-inner" data-width="form">
        <div className="mk-done-page">
          <Stage entry={keyOf(item)} size="card" />
          <h1 className="mk-display-sm">{item.title} is waiting for review</h1>
          <p className="mk-lead" style={{ fontSize: 15 }}>
            It's listed as soon as ace signs it. Its state shows on your profile.
          </p>
          <Button
            variant="primary"
            size="lg"
            style={{ marginTop: 16 }}
            onClick={() => nav.popTo(1)}
          >
            Go to your profile
          </Button>
        </div>
      </div>
    );
  if (step === "Type")
    return (
      <div className="mk-inner" data-width="form">
        <Steps now={now} />
        <h1 className="mk-display-sm">What are you publishing?</h1>
        <div
          className="mk-cards"
          data-cols="4"
          data-quad=""
          data-phone="grid"
          style={{ marginTop: 32 }}
        >
          {choices.map((choice) => (
            <button
              key={choice.type}
              type="button"
              className="mk-choice"
              onClick={() => {
                setType(choice.type);
                setItem(undefined);
                setStep("Item");
              }}
            >
              <Stage
                entry={{ source: "market", type: choice.type, name: choice.name.toLowerCase() }}
                size="card"
              />
              <span className="mk-card-words">
                <span className="mk-name">{choice.name}</span>
                <span className="mk-line">{choice.line}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  if (step === "Item" && type)
    return (
      <div className="mk-inner" data-width="form">
        <Steps now={now} />
        <h1 className="mk-display-sm">
          Which {type === "suit" ? "Suit" : typeWord(type).toLowerCase()}?
        </h1>
        <div className="mk-cards" data-cols="3" data-phone="grid" style={{ marginTop: 32 }}>
          {port.items(type).map((each) => (
            <button
              key={each.name}
              type="button"
              className="mk-choice"
              aria-pressed={item?.name === each.name}
              onClick={() => setItem(each)}
            >
              <Stage entry={keyOf(each)} size="card" />
              <span className="mk-card-words">
                <span className="mk-name">{each.title}</span>
                <span className="mk-meta">{each.state}</span>
              </span>
            </button>
          ))}
        </div>
        <Foot>
          <Button variant="ghost" size="lg" onClick={() => setStep("Type")}>
            Back
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!item}
            onClick={() => {
              if (item) {
                runChecks(item);
                setStep("Check");
              }
            }}
          >
            Next
          </Button>
        </Foot>
      </div>
    );
  if (step === "Check" && item) {
    const failing = checks?.filter((check) => check.verdict === "block").length ?? 0;
    return (
      <div className="mk-inner" data-width="form">
        <Steps now={now} />
        <div className="mk-check-summary">
          <Stage entry={keyOf(item)} size="small" />
          <div style={{ display: "grid", gap: 4 }}>
            <h1 className="mk-display-sm">{item.title}</h1>
            <span className="mk-line">
              {typeWord(item.type)} · {item.version}
            </span>
          </div>
        </div>
        <div>
          {checks?.map((check) => (
            <div
              key={check.id}
              className="mk-check"
              data-ok={check.verdict !== "block" ? "" : undefined}
            >
              {check.verdict === "block" ? (
                <WarningCircleIcon aria-hidden weight="fill" />
              ) : (
                <CheckCircleIcon aria-hidden weight="fill" />
              )}
              <div>
                <p style={{ margin: 0 }}>{check.sentence}</p>
              </div>
              <span />
            </div>
          ))}
          {failed && <p className="mk-withdrawn-line">{failed}</p>}
        </div>
        <Foot
          left={
            !checks ? null : failing ? (
              <span style={{ color: "var(--status-failed)" }}>
                {failing} {failing === 1 ? "check" : "checks"} to fix before you publish.
              </span>
            ) : (
              <Status tone="done">Passes ace's checks.</Status>
            )
          }
        >
          <Button variant="ghost" size="lg" onClick={() => setStep("Item")}>
            Back
          </Button>
          {failing > 0 && (
            <Button variant="secondary" size="lg" onClick={() => runChecks(item)}>
              Check again
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            disabled={!checks || failing > 0}
            onClick={() => {
              setListing(
                (before) =>
                  before ?? {
                    title: item.title,
                    line: item.line,
                    description: "",
                    categories: [],
                    version: item.version,
                  },
              );
              setStep("Describe");
            }}
          >
            Next
          </Button>
        </Foot>
      </div>
    );
  }
  if (step === "Describe" && item && listing)
    return (
      <Describe
        port={port}
        item={item}
        listing={listing}
        onChange={setListing}
        now={now}
        onBack={() => setStep("Check")}
        onPublish={() => {
          setFailed(undefined);
          port.publish(item, listing).then(
            () => setStep("done"),
            () => setFailed("It couldn't be published. Try again."),
          );
        }}
        failed={failed}
      />
    );
  return null;
}

function Describe(props: {
  port: MarketPublishPort;
  item: MarketPublishItem;
  listing: MarketListingDraft;
  onChange(listing: MarketListingDraft): void;
  now: number;
  onBack(): void;
  onPublish(): void;
  failed: string | undefined;
}) {
  const { listing, item } = props;
  const set = (patch: Partial<MarketListingDraft>) => props.onChange({ ...listing, ...patch });
  const toggle = (id: string) =>
    set({
      categories: listing.categories.includes(id)
        ? listing.categories.filter((each) => each !== id)
        : listing.categories.length < 3
          ? [...listing.categories, id]
          : listing.categories,
    });
  const preview = {
    source: "market",
    type: item.type,
    name: item.name,
    title: listing.title || item.title,
    line: listing.line || "One line about it",
    categories: [],
    keywords: [],
    reviewed: false,
    byAce: false,
    updated: 0,
    downloads: 0,
    supported: true,
  };
  return (
    <div className="mk-inner" data-width="form">
      <Steps now={props.now} />
      <div className="mk-describe">
        <div className="mk-form">
          <div>
            <label className="mk-label" htmlFor="mk-pub-name">
              Name
            </label>
            <input
              id="mk-pub-name"
              className="mk-field"
              value={listing.title}
              onChange={(event) => set({ title: event.target.value })}
            />
          </div>
          <div>
            <label className="mk-label" htmlFor="mk-pub-line">
              One line <span className="mk-hint-count">{listing.line.length}/80</span>
            </label>
            <input
              id="mk-pub-line"
              className="mk-field"
              maxLength={80}
              value={listing.line}
              onChange={(event) => set({ line: event.target.value })}
            />
          </div>
          <div>
            <label className="mk-label" htmlFor="mk-pub-description">
              Description
            </label>
            <textarea
              id="mk-pub-description"
              className="mk-field"
              rows={4}
              value={listing.description}
              onChange={(event) => set({ description: event.target.value })}
            />
          </div>
          {props.port.categories.length > 0 && (
            <div>
              <span className="mk-label">
                Categories <span className="mk-hint-count">Up to 3</span>
              </span>
              <div className="mk-chips">
                {props.port.categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className="mk-chip"
                    aria-pressed={listing.categories.includes(category.id)}
                    onClick={() => toggle(category.id)}
                  >
                    {category.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div style={{ maxWidth: 200 }}>
            <label className="mk-label" htmlFor="mk-pub-version">
              Version
            </label>
            <input
              id="mk-pub-version"
              className="mk-field"
              value={listing.version}
              onChange={(event) => set({ version: event.target.value })}
            />
          </div>
        </div>
        <aside className="mk-listing-preview" inert>
          <span className="mk-label">In the marketplace</span>
          <Card entry={preview} />
        </aside>
      </div>
      <Foot
        left={props.failed && <span style={{ color: "var(--status-failed)" }}>{props.failed}</span>}
      >
        <Button variant="ghost" size="lg" onClick={props.onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={!listing.title.trim()}
          onClick={props.onPublish}
        >
          Publish
        </Button>
      </Foot>
    </div>
  );
}
