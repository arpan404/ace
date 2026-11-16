import { formatAge } from "@ace/ui-core/time";
import { CaretLeftIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";

/* What the Library's pages and past work share: a row, a document's top, and its day words. */

/** "today", "yesterday", "Nov 13", or with the year when it isn't this one. */
const day = (time: number) => new Date(time).toDateString();

export function dayWords(at: number, now: number): string {
  if (day(at) === day(now)) return "today";
  if (day(at) === day(now - 86_400_000)) return "yesterday";
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** The first letter up: "today" leading a line. */
export const leading = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The first lines of a page's body as plain words: no marks, no line breaks. */
export function plainLine(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~[\]]/g, "")
    .replace(/\(https?:[^)]*\)/g, "")
    .replace(/^\s*-\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A page or a piece of past work in a list: its title and age, then a line or two of it. */
export function LibraryRow(props: {
  title: string;
  line: string;
  at: number;
  now: number;
  /** A search's words, marked where they show. */
  mark?: string | undefined;
  onOpen(): void;
}) {
  return (
    <li className="flex">
      <button
        type="button"
        onClick={props.onOpen}
        className="-mx-2 my-1 grid min-w-0 flex-1 grid-cols-[1fr_auto] gap-x-3 rounded-md px-2 py-1.5 text-left focus-ring-inset hover:bg-hover"
      >
        <span className="min-w-0 truncate text-ui font-medium text-foreground">{props.title}</span>
        <span className="text-xs leading-5 text-subtle-foreground tabular-nums">
          {formatAge(props.at, props.now)}
        </span>
        {props.line && (
          <span className="col-start-1 line-clamp-2 min-w-0 text-xs leading-[18px] text-subtle-foreground">
            <Marked text={props.line} query={props.mark} />
          </span>
        )}
      </button>
    </li>
  );
}

/** A document's top: ‹ Library back, then its own actions at the end. */
export function DocTop(props: { onBack(): void; children?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-1">
      <button
        type="button"
        onClick={props.onBack}
        className="-ml-2 flex h-8 items-center gap-0.5 rounded-full pr-3 pl-1.5 text-ui font-medium text-muted-foreground focus-ring hover:bg-hover hover:text-foreground"
      >
        <Icon icon={CaretLeftIcon} size={16} />
        Library
      </button>
      <span className="flex-1" />
      {props.children}
    </div>
  );
}

/** A topic for a page the person adds, from its title: "Booking rules" files under booking-rules. */
export function topicOf(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || "notes";
}

/** `text` with each of the query's words in full ink and weight. */
export function Marked(props: { text: string; query: string | undefined }) {
  const words = (props.query ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return props.text;
  const parts = props.text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return parts.map((part, at) =>
    at % 2 === 1 ? (
      // oxlint-disable-next-line react/no-array-index-key -- the parts of one fixed string never reorder
      <mark key={at} className="bg-transparent font-semibold text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
