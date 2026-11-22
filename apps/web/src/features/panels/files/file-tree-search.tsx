import { SearchField } from "@/components/search-field.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

/**
 * The tree's filter, in ace's search field. The field keeps the keyboard while it filters: ↓ and
 * ↑ move through the matches and Enter opens the highlighted one; with nothing typed, ↓ goes to
 * the tree's first row. Escape clears it.
 */
export function FileTreeSearch(props: {
  query: string;
  onQuery(query: string): void;
  /** A search is on its way. */
  pending: boolean;
  /** ↓: the tree's first row, or while filtering the next match. */
  onFirstRow(): void;
  /** ↑ while filtering: the previous match. */
  onPrevious(): void;
  /** While filtering with matches: their list, and the one Enter opens. */
  matches?: { list: string; active: string } | undefined;
  onEnter(): void;
}) {
  return (
    <div className="shrink-0 px-2 pt-2 pb-1">
      <SearchField
        label="Find files in the checkout"
        placeholder="Find files"
        value={props.query}
        onValueChange={props.onQuery}
        aria-controls={props.matches?.list}
        aria-activedescendant={props.matches?.active}
        spellCheck={false}
        autoComplete="off"
        trailing={props.pending ? <Spinner className="mr-1.5" /> : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Clearing is the field's; with nothing typed, the keyboard stays here.
            if (!props.query) event.preventDefault();
            event.stopPropagation();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            props.onFirstRow();
          } else if (event.key === "ArrowUp" && props.query) {
            event.preventDefault();
            props.onPrevious();
          } else if (event.key === "Enter") {
            props.onEnter();
          }
        }}
      />
    </div>
  );
}
