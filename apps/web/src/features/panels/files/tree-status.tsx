import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";

function Note(props: { children: ReactNode; role?: "alert" }) {
  return (
    <p
      role={props.role}
      className="flex min-h-7 items-center gap-2 px-1 py-1 text-ui leading-snug text-muted-foreground"
    >
      {props.children}
    </p>
  );
}

/** The line under the tree when it has nothing to list: offline, searching, failed or empty. */
export function TreeStatus(props: {
  online: boolean;
  searching: boolean;
  query: string;
  search: { error: Error | null; pending: boolean; refetch(): unknown };
  results: readonly unknown[] | undefined;
  empty: boolean;
}) {
  const { online, searching, search, results } = props;
  if (searching && !online)
    return <Note>ace is offline. Search works again once it reconnects.</Note>;
  if (searching && search.error)
    return (
      <Note role="alert">
        Couldn't search the checkout. {search.error.message}{" "}
        <button
          type="button"
          className="font-medium text-foreground underline-offset-2 hover:underline"
          onClick={() => void search.refetch()}
        >
          Try again
        </button>
      </Note>
    );
  if (searching && search.pending && !results?.length)
    return (
      <Note>
        <Spinner /> Searching files…
      </Note>
    );
  if (searching && results && !results.length)
    return <Note>No files match “{props.query.trim()}”.</Note>;
  if (!searching && !online)
    return <Note>ace is offline. Files load again once it reconnects.</Note>;
  if (!searching && props.empty) return <Note>This checkout is empty.</Note>;
  return null;
}
