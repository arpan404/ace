import type { ParsedBrowserAnnotations, ParsedCodeAnnotation } from "@ace/ui-core";
import { ChatTeardropTextIcon } from "@ace/icons";
import { codeIntentWords, displayAddress } from "@ace/ui-core";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { annotationCount, changeSummary } from "./annotation-words.ts";
import { MarkerNumber, PlaceBadge, TagBadge } from "./marker.tsx";
import { badgeFor, regionContents } from "./region-summary.ts";

/**
 * A sent message's annotations in the transcript: folded to their count, open to each browser
 * marker's element, page text and comment, grouped under the page they were pinned on, then
 * each code annotation's file and lines, its first line of code and the comment.
 */
export function AnnotationsCard(props: {
  annotations?: ParsedBrowserAnnotations | undefined;
  code?: readonly ParsedCodeAnnotation[] | undefined;
}) {
  const items = props.annotations?.items ?? [];
  const code = props.code ?? [];
  const pages = [...new Set(items.map((item) => item.url))];
  return (
    <Disclosure
      className="mt-2 font-sans whitespace-normal"
      summaryClassName="text-ui"
      summary={
        <span className="flex items-center gap-1.5">
          <ChatTeardropTextIcon aria-hidden size={14} />
          {annotationCount(items.length + code.length)}
        </span>
      }
    >
      <div className="mt-1.5 flex flex-col gap-2">
        {pages.map((url) => (
          <section key={url} aria-label={`Annotations on ${displayAddress(url)}`}>
            {pages.length > 1 && (
              <p className="truncate text-xs text-subtle-foreground">{displayAddress(url)}</p>
            )}
            <ol className="flex flex-col gap-1.5">
              {items
                .filter((item) => item.url === url)
                .map((item) => {
                  const excerpt =
                    item.kind === "region" ? regionContents(item.elements ?? []) : item.text;
                  return (
                    <li key={item.number} className="flex min-w-0 items-start gap-2">
                      <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
                        <MarkerNumber number={item.number} />
                        <TagBadge tag={badgeFor(item.kind, item.tag)} />
                      </span>
                      <span className="min-w-0 flex-1 text-ui">
                        {excerpt && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {excerpt}
                          </span>
                        )}
                        {item.comment && (
                          <span className="block whitespace-pre-wrap text-foreground">
                            {item.comment}
                          </span>
                        )}
                        {(item.styles.length > 0 || item.textChange) && (
                          <span className="block text-xs text-subtle-foreground">
                            {changeSummary(item.styles.length, !!item.textChange)}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
            </ol>
          </section>
        ))}
        {code.length > 0 && <CodeList code={code} />}
      </div>
    </Disclosure>
  );
}

/** The code annotations of a sent message, in their order. */
function CodeList(props: { code: readonly ParsedCodeAnnotation[] }) {
  return (
    <ol aria-label="Annotations on code" className="flex flex-col gap-1.5">
      {props.code.map((item) => (
        <li key={item.number} className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 flex min-w-0 shrink-0 items-center gap-1.5">
            <MarkerNumber number={item.number} />
            <PlaceBadge text={codeBadge(item)} />
          </span>
          <span className="min-w-0 flex-1 text-ui">
            {firstCodeLine(item.code) && (
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {firstCodeLine(item.code)}
              </span>
            )}
            {(item.comment || item.intent) && (
              <span className="block whitespace-pre-wrap text-foreground">
                {item.comment || (item.intent ? codeIntentWords[item.intent] : "")}
              </span>
            )}
            {(item.side === "old" || item.outdated) && (
              <span className="block text-xs text-subtle-foreground">
                {[item.side === "old" && "Before the change", item.outdated && "Outdated"]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** `total.ts:12–18`: the file's name and the lines, as a badge reads. */
export function codeBadge(item: { path: string; first: number; last: number }): string {
  const name = item.path.split("/").at(-1) ?? item.path;
  return `${name}:${item.last > item.first ? `${item.first}–${item.last}` : item.first}`;
}

/** The first line of code that has any, as a row's excerpt. */
export const firstCodeLine = (code: string) =>
  code
    .split("\n")
    .find((line) => line.trim())
    ?.trim() ?? "";
