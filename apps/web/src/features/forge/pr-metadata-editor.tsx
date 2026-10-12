import { useState } from "react";
import { z } from "zod";
import {
  ForgePrMetadata,
  type ForgeLifecycleSnapshot,
  type ForgeLifecycleAction,
} from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
const Draft = z.object({
  version: z.string(),
  original: ForgePrMetadata,
  value: z.object({
    title: z.string().max(256),
    body: z.string().max(65_536),
    baseBranch: z.string().max(256),
    labels: z.array(z.string().max(256)).max(100),
    assignees: z.array(z.string().max(100)).max(100),
  }),
});
function changes(original: ForgePrMetadata, value: ForgePrMetadata): Partial<ForgePrMetadata> {
  const result: Partial<ForgePrMetadata> = {};
  if (original.title !== value.title) result.title = value.title;
  if (original.body !== value.body) result.body = value.body;
  if (original.baseBranch !== value.baseBranch) result.baseBranch = value.baseBranch;
  if (JSON.stringify(original.labels.toSorted()) !== JSON.stringify(value.labels.toSorted()))
    result.labels = value.labels;
  if (JSON.stringify(original.assignees.toSorted()) !== JSON.stringify(value.assignees.toSorted()))
    result.assignees = value.assignees;
  return result;
}
export function PrMetadataEditor(props: {
  snapshot: ForgeLifecycleSnapshot;
  disabled: boolean;
  apply(action: ForgeLifecycleAction, version: string): Promise<boolean>;
}) {
  const key = `ace:pr-metadata:${JSON.stringify(props.snapshot.pr)}`;
  const fresh = () => ({
    version: props.snapshot.version,
    original: props.snapshot.metadata,
    value: props.snapshot.metadata,
  });
  const [draft, setDraft] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? Draft.parse(JSON.parse(raw)) : fresh();
    } catch {
      return fresh();
    }
  });
  const save = (next: z.infer<typeof Draft>) => {
    setDraft(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Failed writes still retain the in-memory edit. */
    }
  };
  const edits = changes(draft.original, draft.value);
  const dirty = Object.keys(edits).length > 0;
  const stale = dirty && draft.version !== props.snapshot.version;
  const effectiveVersion = dirty ? draft.version : props.snapshot.version;
  const value = dirty ? draft.value : props.snapshot.metadata;
  const editable = (field: keyof ForgePrMetadata) => props.snapshot.editableFields.includes(field);
  const update = (field: keyof ForgePrMetadata, next: string | string[]) =>
    save({
      version: effectiveVersion,
      original: dirty ? draft.original : props.snapshot.metadata,
      value: { ...value, [field]: next },
    });
  return (
    <form
      className="space-y-3"
      aria-label="Edit pull request metadata"
      onSubmit={(e) => {
        e.preventDefault();
        void props
          .apply(
            {
              kind: "edit",
              changes: {
                ...edits,
                ...(edits.labels
                  ? { labels: edits.labels.map((v) => v.trim()).filter(Boolean) }
                  : {}),
                ...(edits.assignees
                  ? { assignees: edits.assignees.map((v) => v.trim()).filter(Boolean) }
                  : {}),
              },
            },
            effectiveVersion,
          )
          .then((ok) => {
            if (ok) save({ version: effectiveVersion, original: value, value });
          });
      }}
    >
      <label className="block text-sm">
        PR title
        <Input
          aria-label="PR title"
          value={value.title}
          maxLength={256}
          disabled={props.disabled || !editable("title")}
          onChange={(e) => update("title", e.target.value)}
        />
      </label>
      <label className="block text-sm">
        PR description
        <Textarea
          aria-label="PR description"
          value={value.body}
          maxLength={65_536}
          disabled={props.disabled || !editable("body")}
          onChange={(e) => update("body", e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Base branch
        <Input
          aria-label="Base branch"
          value={value.baseBranch}
          maxLength={256}
          disabled={props.disabled || !editable("baseBranch")}
          onChange={(e) => update("baseBranch", e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Labels, one per line
        <Textarea
          aria-label="PR labels"
          value={value.labels.join("\n")}
          disabled={props.disabled || !editable("labels")}
          onChange={(e) => update("labels", e.target.value.split("\n"))}
        />
      </label>
      <label className="block text-sm">
        Assignees, one username per line
        <Textarea
          aria-label="PR assignees"
          value={value.assignees.join("\n")}
          disabled={props.disabled || !editable("assignees")}
          onChange={(e) => update("assignees", e.target.value.split("\n"))}
        />
      </label>
      {stale && (
        <p role="status">
          The PR changed since this edit began. Your text is retained. Compare it with the refreshed
          PR before saving.
        </p>
      )}
      {stale && (
        <Button
          type="button"
          disabled={props.disabled}
          onClick={() =>
            save({
              version: props.snapshot.version,
              original: props.snapshot.metadata,
              value: { ...props.snapshot.metadata, ...edits },
            })
          }
        >
          Use refreshed PR for this edit
        </Button>
      )}
      <Button
        type="submit"
        disabled={
          props.disabled ||
          !dirty ||
          stale ||
          Object.keys(edits).some(
            (field) => !props.snapshot.editableFields.some((allowed) => allowed === field),
          ) ||
          !value.title.trim() ||
          !value.baseBranch.trim()
        }
      >
        Save PR metadata
      </Button>
      <Button type="button" disabled={props.disabled} onClick={() => save(fresh())}>
        Reload metadata
      </Button>
    </form>
  );
}
