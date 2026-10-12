import { gitFailureText } from "../lib/git-failure.ts";
import { usePrReference } from "../lib/use-pr-reference.ts";
import type { ForgeRepository } from "@ace/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";

/** The same validated field for Work and the row's link dialog. */
export function PrLinkForm(props: {
  repository: ForgeRepository | undefined;
  pending: boolean;
  onLink(number: number, repository?: ForgeRepository): Promise<unknown>;
  onDone?(): void;
}) {
  const parseReference = usePrReference();
  const [validating, setValidating] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (validating || props.pending) return;
        setValidating(true);
        setError(undefined);
        try {
          const parsed = await parseReference(value, props.repository);
          if ("error" in parsed) return setError(parsed.error);
          await props.onLink(parsed.number, parsed.repository);
          setValue("");
          props.onDone?.();
        } catch (reason: unknown) {
          setError(gitFailureText(reason));
        } finally {
          setValidating(false);
        }
      }}
    >
      <div className="flex items-center gap-1 px-1.5 py-1">
        <Input
          autoFocus
          className="h-7 text-xs"
          aria-label="Link pull request…"
          placeholder="URL or #number"
          value={value}
          maxLength={2000}
          disabled={props.pending || validating}
          onChange={(event) => setValue(event.target.value)}
        />
        {value.trim() && (
          <Button type="submit" variant="ghost" size="sm" disabled={props.pending || validating}>
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
