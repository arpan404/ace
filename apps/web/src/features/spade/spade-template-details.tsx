import type {
  MarketVisibility,
  ShareTemplateDetails,
  ShareTemplateReview,
} from "@ace/protocol/marketplace";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.tsx";

type Edits = Omit<ShareTemplateReview, "visibility">;

function editsOf(details: ShareTemplateDetails): Edits {
  const { recipe } = details.draft;
  return {
    revision: details.revision,
    name: recipe.name,
    description: recipe.blurb,
    task: recipe.task,
    skills: recipe.skills,
    notes: recipe.notes,
    routines: recipe.triggers.flatMap((trigger) =>
      trigger.kind === "schedule"
        ? [{ name: trigger.name, instruction: trigger.instruction, schedule: trigger.schedule }]
        : [],
    ),
    connectors: recipe.needs.connectors.map(({ id }) => id),
  };
}

type SheetProps = {
  details: ShareTemplateDetails | undefined;
  error: string | undefined;
  destination: MarketVisibility;
  setDestination(value: MarketVisibility): void;
  close(): void;
  publish(review: ShareTemplateReview): Promise<void>;
};

export function TemplateDetailsSheet(props: SheetProps) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) props.close();
      }}
    >
      <SheetContent className="w-full max-w-full gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Template details</SheetTitle>
          <SheetDescription>Review the exact contents before sharing.</SheetDescription>
        </SheetHeader>
        {props.details ? (
          <ReviewFields key={props.details.revision} {...props} details={props.details} />
        ) : (
          <p className="p-4" role={props.error ? "alert" : "status"}>
            {props.error ?? "Loading template…"}
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ReviewFields(props: SheetProps & { details: ShareTemplateDetails }) {
  const [edits, setEdits] = useState(() => editsOf(props.details));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const readOnly = pending || props.details.visibility !== null;
  const set = <K extends keyof Edits>(key: K, value: Edits[K]) =>
    setEdits((previous) => ({ ...previous, [key]: value }));
  const remove = (key: "skills" | "notes" | "routines" | "connectors", index: number) =>
    setEdits((previous) => ({ ...previous, [key]: previous[key].filter((_, i) => i !== index) }));
  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      await props.publish({ ...edits, visibility: props.destination });
      props.close();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't publish the template.");
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <div className="flex flex-col gap-4 overflow-auto px-4 pb-4">
        <Text
          label="Name"
          value={edits.name}
          limit={80}
          readOnly={readOnly}
          onChange={(value) => set("name", value)}
        />
        <Text
          label="Description"
          value={edits.description}
          limit={300}
          readOnly={readOnly}
          onChange={(value) => set("description", value)}
        />
        <Text
          label="Task"
          value={edits.task}
          limit={20_000}
          readOnly={readOnly}
          onChange={(value) => set("task", value)}
        />
        <div className="space-y-2">
          <h3 className="font-medium">Skills</h3>
          {edits.skills.length === 0 && <p className="text-muted-foreground">None</p>}
          {edits.skills.map((skill, index) => {
            const file = props.details.draft.skills.find(({ reference }) => reference === skill);
            return (
              <div key={skill}>
                <div className="flex items-center justify-between gap-2">
                  <strong className="font-medium">{skill}</strong>
                  {!readOnly && <Remove label={skill} onClick={() => remove("skills", index)} />}
                </div>
                {file && (
                  <details>
                    <summary>SKILL.md</summary>
                    <pre className="text-xs wrap-anywhere whitespace-pre-wrap">{file.text}</pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
        <div className="space-y-2">
          <h3 className="font-medium">Generalized notes</h3>
          {edits.notes.length === 0 && <p className="text-muted-foreground">None</p>}
          {edits.notes.map((note, index) => (
            // A note has no ID, and its text changes as the person edits it.
            // oxlint-disable-next-line react/no-array-index-key
            <div key={index}>
              <Text
                label={`Note ${index + 1}`}
                value={note}
                limit={2000}
                readOnly={readOnly}
                onChange={(value) =>
                  set(
                    "notes",
                    edits.notes.map((each, i) => (i === index ? value : each)),
                  )
                }
              />
              {!readOnly && (
                <Remove label={`note ${index + 1}`} onClick={() => remove("notes", index)} />
              )}
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <h3 className="font-medium">Routines</h3>
          {edits.routines.length === 0 && <p className="text-muted-foreground">None</p>}
          {edits.routines.map((routine, index) => (
            // oxlint-disable-next-line react/no-array-index-key
            <div key={index} className="space-y-2">
              {(["name", "schedule", "instruction"] as const).map((field) => (
                <Text
                  key={field}
                  label={`Routine ${index + 1} ${field}`}
                  value={routine[field]}
                  limit={field === "instruction" ? 20_000 : field === "schedule" ? 500 : 200}
                  readOnly={readOnly}
                  onChange={(value) =>
                    set(
                      "routines",
                      edits.routines.map((each, i) =>
                        i === index ? { ...each, [field]: value } : each,
                      ),
                    )
                  }
                />
              ))}
              {!readOnly && (
                <Remove label={`routine ${index + 1}`} onClick={() => remove("routines", index)} />
              )}
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <h3 className="font-medium">Needed connectors</h3>
          {edits.connectors.length === 0 && <p className="text-muted-foreground">None</p>}
          {edits.connectors.map((id, index) => (
            <div key={id} className="flex items-center justify-between gap-2">
              <span>{id}</span>
              {!readOnly && <Remove label={id} onClick={() => remove("connectors", index)} />}
            </div>
          ))}
        </div>
        <div>
          <h3 className="font-medium">Left out</h3>
          <ul className="list-inside list-disc text-muted-foreground">
            {props.details.draft.left_out.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
      {props.details.visibility === null && (
        <SheetFooter>
          <div aria-label="Destination" role="group" className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={props.destination === "listed"}
              disabled={pending}
              onClick={() => props.setDestination("listed")}
            >
              Store listing
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={props.destination === "unlisted"}
              disabled={pending}
              onClick={() => props.setDestination("unlisted")}
            >
              Anyone with the link
            </Button>
          </div>
          <p className="text-muted-foreground">
            The Store reviews and signs the template before anyone can install it.
          </p>
          {error && <p role="alert">{error}</p>}
          <Button disabled={pending} onClick={() => void submit()}>
            {pending
              ? "Submitting…"
              : props.destination === "listed"
                ? "Confirm publication"
                : "Confirm link sharing"}
          </Button>
        </SheetFooter>
      )}
    </>
  );
}

function Text(props: {
  label: string;
  value: string;
  limit: number;
  readOnly: boolean;
  onChange(value: string): void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-medium">{props.label}</span>
      <textarea
        rows={props.limit <= 500 ? 1 : 3}
        maxLength={props.limit}
        value={props.value}
        readOnly={props.readOnly}
        className="rounded-md border border-border bg-background p-2 text-ui"
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function Remove(props: { label: string; onClick(): void }) {
  return (
    <Button size="sm" variant="ghost" aria-label={`Remove ${props.label}`} onClick={props.onClick}>
      Remove
    </Button>
  );
}
