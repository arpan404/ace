import type { MarketReviewItem } from "@ace/protocol/marketplace";
import { sizeText } from "./market-model.ts";

/*
 * A review's pages, as the review page lists them under quiet heads: what changed in an update,
 * the commands it runs, its texts and its files. The person reads these before Install.
 */

const changeWords = { added: "Added", changed: "Changed", removed: "Removed" } as const;

type Execution = Extract<MarketReviewItem, { kind: "execution" }>["execution"];

function runTitle(execution: Execution): string {
  switch (execution.kind) {
    case "hook":
      return `Hook on ${execution.event}`;
    case "stdio":
      return `Server ${execution.name}`;
    case "remote":
      return `Remote server ${execution.name}`;
  }
}

function runDetail(execution: Execution): string {
  switch (execution.kind) {
    case "hook":
      return execution.command;
    case "stdio":
      return [execution.command, ...execution.args].join(" ");
    case "remote":
      return execution.url;
  }
}

export function ReviewItems(props: { items: readonly MarketReviewItem[] }) {
  const changes = props.items.filter((item) => item.kind === "change");
  const runs = props.items.filter((item) => item.kind === "execution");
  const texts = props.items.filter((item) => item.kind === "text");
  const files = props.items.filter((item) => item.kind === "file");
  const notes = props.items.filter((item) => item.kind === "note");
  return (
    <>
      {changes.length > 0 && (
        <>
          <h3 className="mk-quiet-head">What changed</h3>
          {changes.map((item) => (
            <div key={`${item.section}/${item.path}`} className="mk-fact-row">
              <span className="mk-words">
                <span className="mk-name">
                  {changeWords[item.change]} {item.path}
                </span>
                {item.executable && <span className="mk-meta">A script or program.</span>}
              </span>
            </div>
          ))}
        </>
      )}
      {runs.length > 0 && (
        <>
          <h3 className="mk-quiet-head">What it runs</h3>
          {runs.map((item) => (
            <div
              key={`${item.section}/${runTitle(item.execution)}/${runDetail(item.execution)}`}
              className="mk-fact-row"
            >
              <span className="mk-words">
                <span className="mk-name">{runTitle(item.execution)}</span>
                <code
                  className="mk-meta"
                  style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}
                >
                  {runDetail(item.execution)}
                </code>
              </span>
            </div>
          ))}
        </>
      )}
      {texts.map((item) => (
        <div key={`${item.section}/${item.path}/${item.before}`}>
          <h3 className="mk-quiet-head">{item.before ? `${item.path} before` : item.path}</h3>
          <pre className="mk-pre">{item.text}</pre>
        </div>
      ))}
      {files.length > 0 && (
        <>
          <h3 className="mk-quiet-head">Files</h3>
          {files.map((item) => (
            <div
              key={`${item.section}/${item.file.path}`}
              className="mk-fact-row"
              style={{ minHeight: 40 }}
            >
              <span className="mk-words">
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
                  {item.file.path}
                </span>
              </span>
              <span className="mk-meta">
                {sizeText(item.file.bytes)}
                {item.file.flagged ? " · A script or program" : ""}
              </span>
            </div>
          ))}
        </>
      )}
      {notes.map((item) => (
        <p key={`${item.section}/${item.text}`} className="mk-line" style={{ marginTop: 16 }}>
          {item.text}
        </p>
      ))}
    </>
  );
}
