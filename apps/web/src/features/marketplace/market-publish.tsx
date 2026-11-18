import type { MarketDraft } from "@ace/protocol/marketplace";
import { CheckCircleIcon, WarningCircleIcon } from "@ace/icons";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Empty } from "./market-card.tsx";
import { failureSentence, findingSentences, MarketFailure, typeWord } from "./market-model.ts";
import { Status } from "./market-marks.tsx";
import { useMarketNav } from "./market-nav.ts";
import { Describe } from "./market-publish-describe.tsx";
import { Foot, keyOf, Steps, steps, type Step } from "./market-publish-parts.tsx";
import { ChooseItem } from "./market-publish-item.tsx";
import {
  checkRows,
  usePublishSteps,
  type MarketListingDraft,
  type MarketPublishItem,
  type MarketPublishType,
} from "./market-publish-port.ts";
import { useMarketMe } from "./market-publishing.ts";
import { Stage } from "./market-stage.tsx";

/*
 * Publishing (ADR 0174 §2): what you're publishing, which one, ace's checks on its files (the
 * scan's findings as sentences), then its listing, and it waits for review. Each step has its
 * own page under the same steps line and a sticky foot.
 */

const choices: readonly { type: MarketPublishType; name: string; line: string }[] = [
  { type: "suit", name: "Look", line: "A Suit: colours, fonts and a picture." },
  { type: "spade-bot", name: "Bot", line: "A recipe: face, task, routines and the apps it needs." },
  { type: "spade-skill", name: "Skill", line: "Instructions and scripts a bot can use." },
  { type: "spade-plugin", name: "Plugin", line: "Commands and tools for agents and bots." },
];

export function PublishPage(props: { draft?: string | undefined }) {
  const { me, signedOut } = useMarketMe();
  if (signedOut) return <Empty title="Sign in to publish" />;
  if (!me) return null;
  if (!me.profile) return <Empty title="Make your publisher profile first" />;
  const draft = me.drafts.find((each) => each.id === props.draft);
  return <PublishFlow resume={draft} />;
}

function itemOfDraft(draft: MarketDraft): MarketPublishItem {
  return {
    type: choices.find((choice) => choice.type === draft.type)?.type ?? "spade-skill",
    name: draft.name,
    title: draft.title,
    line: "",
    version: draft.version,
    state: "Draft",
    draft: draft.id,
  };
}

function PublishFlow(props: { resume: MarketDraft | undefined }) {
  const nav = useMarketNav();
  const { me } = useMarketMe();
  const run = usePublishSteps();
  const [step, setStep] = useState<Step>(props.resume ? "Check" : "Type");
  const [type, setType] = useState<MarketPublishType | undefined>(
    props.resume ? itemOfDraft(props.resume).type : undefined,
  );
  const [item, setItem] = useState<MarketPublishItem | undefined>(
    props.resume ? itemOfDraft(props.resume) : undefined,
  );
  const [draft, setDraft] = useState<MarketDraft>();
  const [checking, setChecking] = useState(false);
  const [listing, setListing] = useState<MarketListingDraft>();
  const [failed, setFailed] = useState<{ sentence: string; found: readonly string[] }>();
  const [held, setHeld] = useState(false);
  const runChecks = (chosen: MarketPublishItem) => {
    setDraft(undefined);
    setFailed(undefined);
    setChecking(true);
    run
      .check(chosen)
      .then(
        (next) => {
          setDraft(next);
          // Check again sends the same draft's files, not a new draft.
          setItem((before) => (before ? { ...before, draft: next.id } : before));
        },
        (error: unknown) => setFailed({ sentence: failureSentence(error, "publish"), found: [] }),
      )
      .finally(() => setChecking(false));
  };
  // A draft carried on from the profile opens on its checks.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !props.resume) return;
    resumed.current = true;
    runChecks(itemOfDraft(props.resume));
  });
  const now = step === "done" ? 4 : steps.indexOf(step);
  if (step === "done" && item)
    return (
      <div className="mk-inner" data-width="form">
        <div className="mk-done-page">
          <Stage entry={keyOf(item)} size="card" />
          <h1 className="mk-display-sm">{listing?.title || item.title} is waiting for review</h1>
          <p className="mk-lead" style={{ fontSize: 15 }}>
            {held
              ? "A maintainer looks at it first, then it's listed once ace signs it."
              : "It's listed as soon as ace signs it."}{" "}
            Its state shows on your profile.
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
          data-cols="2"
          data-form="lockup"
          style={{ marginTop: 32 }}
        >
          {choices.map((choice) => (
            <button
              key={choice.type}
              type="button"
              className="mk-choice"
              data-form="lockup"
              onClick={() => {
                setType(choice.type);
                setItem(undefined);
                setStep("Item");
              }}
            >
              <Stage
                entry={{ source: "market", type: choice.type, name: choice.name.toLowerCase() }}
                size="small"
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
      <ChooseItem
        type={type}
        me={me}
        now={now}
        chosen={item}
        onChoose={setItem}
        onBack={() => setStep("Type")}
        onNext={(chosen) => {
          // The confirmed check travels with the item, so Check again sends it too.
          setItem(chosen);
          runChecks(chosen);
          setStep("Check");
        }}
      />
    );
  if (step === "Check" && item) {
    const rows = draft ? checkRows(draft) : [];
    const failing = rows.filter((row) => row.verdict === "block").length;
    return (
      <div className="mk-inner" data-width="form">
        <Steps now={now} />
        <div className="mk-check-summary">
          <Stage entry={keyOf(item)} size="small" />
          <div style={{ display: "grid", gap: 4 }}>
            <h1 className="mk-display-sm">{item.title}</h1>
            <span className="mk-line">
              {typeWord(item.type)} · {item.version}
              {draft ? ` · ${draft.files} ${draft.files === 1 ? "file" : "files"}` : ""}
            </span>
          </div>
        </div>
        <div aria-label="Checks" role="list">
          {checking && <p className="mk-line">Checking its files…</p>}
          {rows.map((row) => (
            <div
              key={row.id}
              role="listitem"
              className="mk-check"
              data-ok={row.verdict !== "block" ? "" : undefined}
            >
              {row.verdict === "block" ? (
                <WarningCircleIcon aria-hidden weight="fill" />
              ) : (
                <CheckCircleIcon aria-hidden weight="fill" />
              )}
              <div>
                <p style={{ margin: 0 }}>{row.sentence}</p>
                {row.found.map((found) => (
                  <p key={found} className="mk-why">
                    {found}
                  </p>
                ))}
              </div>
              <span />
            </div>
          ))}
          {failed && <p className="mk-withdrawn-line">{failed.sentence}</p>}
        </div>
        <Foot
          left={
            !draft || checking ? null : failing ? (
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
          {(failing > 0 || failed) && !checking && (
            <Button variant="secondary" size="lg" onClick={() => runChecks(item)}>
              Check again
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            disabled={!draft || checking || failing > 0}
            onClick={() => {
              setListing(
                (before) =>
                  before ?? {
                    title: item.title,
                    line: item.line,
                    description: "",
                    categories: [],
                    version: draft?.version ?? item.version,
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
  if (step === "Describe" && item && listing && draft)
    return (
      <Describe
        item={item}
        listing={listing}
        onChange={setListing}
        now={now}
        onBack={() => setStep("Check")}
        failed={failed}
        onPublish={() => {
          setFailed(undefined);
          run.publish(draft, listing).then(
            (published) => {
              setHeld(published.held);
              setStep("done");
            },
            (error: unknown) =>
              setFailed({
                sentence: failureSentence(error, "publish"),
                found: error instanceof MarketFailure ? findingSentences(error.scan) : [],
              }),
          );
        }}
      />
    );
  return null;
}
