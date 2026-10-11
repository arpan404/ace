import { useEffect } from "react";
import "./search.css";

/*
 * Marks a search's words inside the transcript row the last jump brought into view (`data-hit`)
 * with the CSS Custom Highlight API: no markup changes, so rendered markdown stays as it is.
 * Rows are virtual and stream, so the marks are laid again (once per frame at most) whenever
 * the feed's rows change.
 */

const name = "ace-find";
/** Marks laid at most per row: a hit in a 64k-character output stays cheap. */
const maxRanges = 200;

function terms(query: string): string[] {
  return [...new Set(query.split(/\s+/).filter((term) => term.length > 0))];
}

function ranges(root: Element, words: readonly string[]): Range[] {
  const found: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && found.length < maxRanges; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (const word of words) {
      const pattern = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      for (const match of text.matchAll(pattern)) {
        if (found.length >= maxRanges) break;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        found.push(range);
      }
    }
  }
  return found;
}

export function useTranscriptHighlight(query: string | undefined): void {
  useEffect(() => {
    if (!query || typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const words = terms(query);
    let frame = 0;
    const apply = () => {
      const hit = document.querySelector("[role='feed'] [data-hit]");
      const marks = hit ? ranges(hit, words) : [];
      if (marks.length) CSS.highlights.set(name, new Highlight(...marks));
      else CSS.highlights.delete(name);
    };
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    const observer = new MutationObserver(later);
    const feed = document.querySelector("[role='feed']");
    if (feed)
      observer.observe(feed, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-hit"],
      });
    apply();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      CSS.highlights.delete(name);
    };
  }, [query]);
}
