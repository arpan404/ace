import { useState, type ReactNode } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";

/** Bounded machine lists, shared by the fleet directory and a machine's connections. */
export function MachineDirectory<T extends { id: string; name: string }>(props: {
  machines: readonly T[];
  label: string;
  children(rows: readonly T[]): ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [requestedPage, setPage] = useState(0);
  const matching = props.machines.filter((machine) =>
    machine.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const pageSize = 20;
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(matching.length / pageSize) - 1));
  const start = page * pageSize;
  const rows = matching.slice(start, start + pageSize);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-3 py-3">
        <SearchField
          label={props.label}
          placeholder="Search machines"
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setPage(0);
          }}
          className="max-w-72"
        />
        <span role="status" className="text-xs text-muted-foreground">
          {matching.length} {matching.length === 1 ? "machine" : "machines"}
        </span>
      </div>
      {matching.length === 0 ? (
        <EmptyState variant="inline" title="No matching machines" />
      ) : (
        props.children(rows)
      )}
      {matching.length > pageSize && (
        <nav
          aria-label={`${props.label} pages`}
          className="flex items-center justify-between gap-3 border-t border-border-soft py-3"
        >
          <span className="text-xs text-muted-foreground">
            {start + 1}–{Math.min(start + pageSize, matching.length)} of {matching.length}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={start + pageSize >= matching.length}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
