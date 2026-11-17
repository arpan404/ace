import type {
  MarketDraftCheck,
  MarketDraftChecked,
  MarketDraftSource,
  MarketPickType,
} from "@ace/protocol/marketplace";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { BotReview } from "./market-publish-bot-review.tsx";
import { failedWords, sizeWords, useDraftCheck, useReport } from "./market-publish-review.ts";

/*
 * What publishing would upload, shown before Next (ADR 0174 §2). For files: every file that
 * would upload, binaries only when ticked, what stayed home and why, and what the checks found:
 * a secret or hidden text holds Next until it is fixed, anything else private waits for the
 * person to say it can be public. For a bot: its recipe, with the task and each routine the
 * person includes edited or confirmed (`BotReview`). Nothing is uploaded from here.
 */

const leftWords = { hidden: "Hidden", credential: "Named like a credential" } as const;

function FilesReview(props: {
  check: MarketDraftCheck;
  onChecked(checked: MarketDraftChecked | undefined): void;
  onAgain(): void;
}) {
  const { check, onChecked } = props;
  const [binaries, setBinaries] = useState<readonly string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const blocking = check.findings.filter((finding) => finding.blocking);
  const open = check.findings.filter((finding) => !finding.blocking);
  const ready = blocking.length === 0 && (open.length === 0 || confirmed);
  const accepted = [...new Set(open.map((finding) => finding.text))];
  useReport(ready ? { hash: check.hash, binaries: [...binaries], accepted } : undefined, onChecked);
  return (
    <section aria-label="Its files" style={{ marginTop: 32, maxWidth: 640 }}>
      <h2 className="mk-quiet-head">What will upload</h2>
      <ul aria-label="What will upload" style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {check.files.map((file) => (
          <li key={file.path} className="mk-fact-row">
            <span className="mk-words">
              <span className="mk-name">{file.path}</span>
              <span className="mk-meta">
                {sizeWords(file.bytes)}
                {file.binary ? " · not text, left out unless you include it" : ""}
              </span>
            </span>
            {file.binary && (
              <label className="mk-state-word">
                <input
                  type="checkbox"
                  aria-label={`Include ${file.path}`}
                  checked={binaries.includes(file.path)}
                  onChange={(event) =>
                    setBinaries((before) =>
                      event.target.checked
                        ? [...before, file.path]
                        : before.filter((path) => path !== file.path),
                    )
                  }
                />{" "}
                Include
              </label>
            )}
          </li>
        ))}
      </ul>
      {check.excluded.length > 0 && (
        <>
          <h3 className="mk-quiet-head">Left out</h3>
          <ul aria-label="Left out" style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {check.excluded.map((item) => (
              <li key={item.path} className="mk-fact-row">
                <span className="mk-words">
                  <span className="mk-name">{item.path}</span>
                  <span className="mk-meta">{leftWords[item.reason]}, so it stays here</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {blocking.length > 0 && (
        <>
          <h3 className="mk-quiet-head">To fix before publishing</h3>
          {blocking.map((finding) => (
            <p
              key={`${finding.path}:${finding.line}:${finding.sentence}`}
              className="mk-withdrawn-line"
            >
              {finding.sentence}
            </p>
          ))}
          <Button variant="secondary" size="sm" onClick={props.onAgain}>
            Check again
          </Button>
        </>
      )}
      {blocking.length === 0 && open.length > 0 && (
        <>
          <h3 className="mk-quiet-head">Check before it is public</h3>
          {open.map((finding) => (
            <p key={`${finding.path}:${finding.line}:${finding.text}`} className="mk-line">
              {finding.path}
              {finding.line ? `, line ${finding.line}` : ""}: {finding.sentence}
            </p>
          ))}
          <label className="mk-line">
            <input
              type="checkbox"
              aria-label="These can be public"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            These can be public
          </label>
        </>
      )}
    </section>
  );
}

/** The check of what publishing `source` would upload, and the person's confirmation of it. */
export function DraftReview(props: {
  type: MarketPickType;
  name: string;
  source: MarketDraftSource;
  onChecked(checked: MarketDraftChecked | undefined): void;
}) {
  const check = useDraftCheck(props.type, props.name, props.source);
  const { onChecked } = props;
  useEffect(() => {
    if (!check.data) onChecked(undefined);
  }, [check.data, onChecked]);
  if (check.error)
    return (
      <p className="mk-withdrawn-line" style={{ marginTop: 32 }}>
        {failedWords(check.error, "This can't be checked now.")}
      </p>
    );
  if (!check.data)
    return (
      <p className="mk-line" style={{ marginTop: 32 }}>
        Checking what would upload…
      </p>
    );
  return check.data.bot ? (
    <BotReview review={check.data.bot} hash={check.data.hash} onChecked={onChecked} />
  ) : (
    <FilesReview
      key={check.data.hash}
      check={check.data}
      onChecked={onChecked}
      onAgain={() => void check.refetch()}
    />
  );
}
