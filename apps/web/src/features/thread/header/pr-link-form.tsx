import { parsePrReference } from "@ace/ui-core";
import type { ForgeRepository } from "@ace/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";

/** The same validated field for the work card and the row's link dialog. */
export function PrLinkForm(props: {
  repository: ForgeRepository | undefined;
  pending: boolean;
  onLink(number: number, repository?: ForgeRepository): Promise<unknown>;
  onDone?(): void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const parsed = parsePrReference(value, props.repository);
        if ("error" in parsed) return setError(parsed.error);
        setError(undefined);
        try {
          await props.onLink(parsed.number, parsed.repository);
          setValue("");
          props.onDone?.();
        } catch (reason: unknown) {
          setError(
            reason instanceof Error ? reason.message : "Couldn't link the pull request. Try again.",
          );
        }
      }}
    >
      <div className="flex items-center gap-1 px-2.5 py-1">
        <Input
          aria-label="Link pull request…"
          placeholder="Link pull request… URL or #number"
          value={value}
          maxLength={2000}
          disabled={props.pending}
          onChange={(event) => setValue(event.target.value)}
        />
        {value.trim() && (
          <Button type="submit" variant="ghost" size="sm" disabled={props.pending}>
            Link
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="px-2.5 py-1 text-sm text-status-failed">
          <InlineMarkdown text={error} />
        </p>
      )}
    </form>
  );
}
