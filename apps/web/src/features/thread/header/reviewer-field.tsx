import { useState } from "react";
import { parseReviewers } from "@ace/ui-core";
import { XIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";

/** Usernames remain editable text until Enter or comma commits them; removal updates the form. */
export function ReviewerField(props: { onChange(text: string): void }) {
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState("");
  const update = (names: readonly string[], text: string) => {
    setPicked(names);
    setDraft(text);
    props.onChange([...names, text].join(", "));
  };
  const commit = () => {
    const parsed = parseReviewers([...picked, draft].join(", "));
    if ("reviewers" in parsed) update(parsed.reviewers, "");
  };
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md bg-input px-2 shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ring)_50%,transparent)]">
      {picked.map((name) => (
        <span key={name} className="inline-flex items-center text-ui text-muted-foreground">
          @{name}
          <IconButton
            icon={XIcon}
            size="sm"
            label={`Remove reviewer ${name}`}
            onClick={() =>
              update(
                picked.filter((each) => each !== name),
                draft,
              )
            }
          />
        </span>
      ))}
      <Input
        aria-label="Reviewers"
        placeholder={picked.length ? "Add reviewer" : "GitHub usernames (optional)"}
        value={draft}
        maxLength={2000}
        className="min-w-24 flex-1 bg-transparent px-0 shadow-none focus:shadow-none"
        onChange={(event) => update(picked, event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && !draft && picked.length)
            update(picked.slice(0, -1), "");
        }}
      />
    </div>
  );
}
