import type { ParsedBrowserAnnotations } from "@ace/ui-core";
import { ChatTeardropTextIcon } from "@phosphor-icons/react";
import { displayAddress } from "@ace/ui-core";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { annotationCount, changeSummary } from "./annotation-chip.tsx";
import { MarkerNumber, TagBadge } from "./marker.tsx";

/**
 * A sent message's browser annotations in the transcript: folded to their count, open to each
 * marker's element, page text and comment, grouped under the page they were pinned on.
 */
export function AnnotationsCard(props: { annotations: ParsedBrowserAnnotations }) {
  const { items } = props.annotations;
  const pages = [...new Set(items.map((item) => item.url))];
  return (
    <Disclosure
      className="mt-2 font-sans whitespace-normal"
      summaryClassName="text-ui"
      summary={
        <span className="flex items-center gap-1.5">
          <ChatTeardropTextIcon aria-hidden size={14} />
          {annotationCount(items.length)}
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
                .map((item) => (
                  <li key={item.number} className="flex min-w-0 items-start gap-2">
                    <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
                      <MarkerNumber number={item.number} />
                      <TagBadge tag={item.tag} />
                    </span>
                    <span className="min-w-0 flex-1 text-ui">
                      {item.text && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.text}
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
                ))}
            </ol>
          </section>
        ))}
      </div>
    </Disclosure>
  );
}
