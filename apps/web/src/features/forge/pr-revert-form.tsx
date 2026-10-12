import { useState } from "react";
import { z } from "zod";
import type { ForgeLifecycleSnapshot, ForgeLifecycleAction } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
const Draft = z.object({ title: z.string().max(256), body: z.string().max(60_000) });
export function PrRevertForm(props: {
  snapshot: ForgeLifecycleSnapshot;
  disabled: boolean;
  apply(action: ForgeLifecycleAction, version: string): Promise<boolean>;
}) {
  const key = `ace:revert:${JSON.stringify(props.snapshot.pr)}`;
  const [draft, setDraft] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return Draft.parse(JSON.parse(raw));
    } catch {
      /* Use the reviewable default. */
    }
    return {
      title: `Revert "${props.snapshot.metadata.title}"`.slice(0, 256),
      body: `Reverts #${props.snapshot.pr.number}.\n\nThis draft proposes undoing the merged change. Review the generated diff and required checks before merging.`,
    };
  });
  const save = (next: z.infer<typeof Draft>) => {
    setDraft(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Retain text on failed writes in memory. */
    }
  };
  return (
    <form
      aria-label="Create revert pull request"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void props.apply({ kind: "revert", ...draft }, props.snapshot.version);
      }}
    >
      <p>
        Create a separate draft PR that reverts this merged change. Its diff, reviews and required
        checks can be inspected before merge.
      </p>
      <Input
        aria-label="Revert PR title"
        maxLength={256}
        value={draft.title}
        onChange={(e) => save({ ...draft, title: e.target.value })}
      />
      <Textarea
        aria-label="Revert PR description"
        maxLength={60_000}
        value={draft.body}
        onChange={(e) => save({ ...draft, body: e.target.value })}
      />
      <section aria-label="Revert PR summary">
        <h4 className="font-medium">{draft.title}</h4>
        <Prose text={draft.body} />
      </section>
      <Button type="submit" disabled={props.disabled || !draft.title.trim()}>
        Create draft revert PR
      </Button>
    </form>
  );
}
