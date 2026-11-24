import type {
  MarketResult,
  MarketVisibility,
  ShareTemplateDetails,
  ShareTemplateDraft,
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

import type { TemplateEdits } from "./spade-template-review.ts";

function editsOf(details: ShareTemplateDetails): TemplateEdits {
  const { recipe } = details.draft;
  return {
    revision: details.revision,
    name: recipe.name,
    description: recipe.blurb,
    task: recipe.task,
    skills: recipe.skills,
    notes: recipe.notes,
    knowledge: recipe.knowledge ?? [],
    include_heartbeat: recipe.heartbeat !== undefined,
    event_routines: recipe.triggers.flatMap((trigger) =>
      trigger.kind === "event" || trigger.kind === "webhook" ? [trigger.name] : [],
    ),
    surfaces: recipe.surfaces?.map(({ id }) => id) ?? [],
    contracts: recipe.contracts?.map(({ name }) => name) ?? [],
    plugins: recipe.plugins ?? [],
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
  preview(
    review: ShareTemplateReview,
  ): Promise<Extract<MarketResult, { op: "templateReview" }>["items"]>;
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
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [items, setItems] = useState<Awaited<ReturnType<SheetProps["preview"]>>>([]);
  const allReviewed = items.length > 0 && items.every(({ digest }) => reviewed.has(digest));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const readOnly = pending || props.details.visibility !== null;
  const replaceEdits = (next: TemplateEdits) => {
    setItems([]);
    setReviewed(new Set());
    setEdits(next);
  };
  const set = <K extends keyof TemplateEdits>(key: K, value: TemplateEdits[K]) =>
    replaceEdits({ ...edits, [key]: value });
  const remove = (
    key:
      | "skills"
      | "notes"
      | "routines"
      | "connectors"
      | "knowledge"
      | "surfaces"
      | "contracts"
      | "plugins"
      | "event_routines",
    index: number,
  ) => replaceEdits({ ...edits, [key]: edits[key].filter((_, i) => i !== index) });
  const preview = async () => {
    setPending(true);
    setError(undefined);
    try {
      setItems(await props.preview({ ...edits, acknowledged: [], visibility: props.destination }));
      setReviewed(new Set());
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't prepare the final package.");
    } finally {
      setPending(false);
    }
  };
  const submit = async () => {
    if (pending || !allReviewed) return;
    setPending(true);
    setError(undefined);
    try {
      await props.publish({ ...edits, acknowledged: [...reviewed], visibility: props.destination });
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
                {file && <Contents name="SKILL.md" text={file.text} />}
                {file?.files.map(({ path, text }) => (
                  <Contents key={path} name={path} text={text} />
                ))}
              </div>
            );
          })}
        </div>
        {edits.knowledge.length > 0 && (
          <div className="space-y-3">
            <h3 className="font-medium">Playbooks and lessons</h3>
            {edits.knowledge.map((entry, index) => (
              // Each page can be edited in place and has no source ID.
              // oxlint-disable-next-line react/no-array-index-key
              <div key={index} className="space-y-2">
                <p className="text-muted-foreground">
                  {entry.kind === "lesson" ? "Lesson" : "Playbook"} · {entry.topic}
                </p>
                {(["title", "body"] as const).map((field) => (
                  <Text
                    key={field}
                    label={field === "title" ? "Page title" : "Page content"}
                    value={entry[field]}
                    limit={field === "title" ? 200 : 8_000}
                    readOnly={readOnly}
                    onChange={(value) =>
                      set(
                        "knowledge",
                        edits.knowledge.map((each, i) =>
                          i === index ? { ...each, [field]: value } : each,
                        ),
                      )
                    }
                  />
                ))}
                {!readOnly && (
                  <Remove label={entry.title} onClick={() => remove("knowledge", index)} />
                )}
              </div>
            ))}
          </div>
        )}
        <WorkingSetup
          draft={props.details.draft}
          edits={edits}
          readOnly={readOnly}
          remove={remove}
          removeHeartbeat={() => set("include_heartbeat", false)}
        />
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
        {props.details.visibility === null && (
          <section aria-label="Required review" className="space-y-2">
            <h3 className="font-medium">Review each item</h3>
            <Button size="sm" disabled={pending} onClick={() => void preview()}>
              Review final package
            </Button>
            {items.map(({ digest, label, text }) => (
              <details key={digest}>
                <summary>{label}</summary>
                <pre className="text-xs wrap-anywhere whitespace-pre-wrap">{text}</pre>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Reviewed ${label}`}
                    disabled={pending}
                    checked={reviewed.has(digest)}
                    onChange={({ currentTarget: { checked } }) => {
                      setReviewed((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(digest);
                        else next.delete(digest);
                        return next;
                      });
                    }}
                  />
                  Reviewed
                </label>
              </details>
            ))}
          </section>
        )}
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
          <Button disabled={pending || !allReviewed} onClick={() => void submit()}>
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

function Contents(props: { name: string; text: string }) {
  return (
    <details>
      <summary>{props.name}</summary>
      <pre className="text-xs wrap-anywhere whitespace-pre-wrap">{props.text}</pre>
    </details>
  );
}

function WorkingSetup(props: {
  draft: ShareTemplateDraft;
  edits: TemplateEdits;
  readOnly: boolean;
  remove(key: "surfaces" | "contracts" | "plugins" | "event_routines", index: number): void;
  removeHeartbeat(): void;
}) {
  const { recipe } = props.draft;
  const heartbeat = props.edits.include_heartbeat ? recipe.heartbeat : undefined;
  return (
    <div className="space-y-2">
      <h3 className="font-medium">Working setup</h3>
      <p>Model · {recipe.model}</p>
      {Object.entries(recipe.model_roles ?? {}).map(([role, model]) => (
        <p key={role}>
          {role} · {model}
        </p>
      ))}
      {recipe.personality !== undefined && (
        <Contents name="Personality" text={JSON.stringify(recipe.personality, null, 2)} />
      )}
      {Array.isArray(recipe.effects) && recipe.effects.length > 0 && (
        <Contents name="Requested effects" text={JSON.stringify(recipe.effects, null, 2)} />
      )}
      {recipe.style && <p>Accent · {recipe.style.accent}</p>}
      {heartbeat && (
        <>
          <Contents
            name={`Heartbeat · every ${heartbeat.every_minutes} minutes`}
            text={heartbeat.checklist}
          />
          {!props.readOnly && <Remove label="heartbeat" onClick={props.removeHeartbeat} />}
        </>
      )}
      {props.edits.event_routines.map((name, index) => {
        const trigger = recipe.triggers.find(
          (item) => (item.kind === "event" || item.kind === "webhook") && item.name === name,
        );
        if (!trigger || (trigger.kind !== "event" && trigger.kind !== "webhook")) return null;
        return (
          <div key={name}>
            <Contents
              name={`${name} · ${trigger.kind === "event" ? trigger.event : "webhook"}`}
              text={trigger.instruction}
            />
            {!props.readOnly && (
              <Remove label={name} onClick={() => props.remove("event_routines", index)} />
            )}
          </div>
        );
      })}
      {props.edits.plugins.map((plugin, index) => (
        <div key={plugin}>
          <span>{plugin}</span>
          {!props.readOnly && (
            <Remove label={plugin} onClick={() => props.remove("plugins", index)} />
          )}
          {recipe.plugin_commands?.[plugin]?.map((command) => (
            <p key={command}>{command}</p>
          ))}
        </div>
      ))}
      {props.edits.surfaces.map((id, index) => {
        const surface = recipe.surfaces?.find((surface) => surface.id === id);
        const file = props.draft.surface_files.find((file) => file.path === surface?.file);
        return (
          <div key={id}>
            <Contents name={`Surface · ${id}`} text={JSON.stringify(surface, null, 2)} />
            {file && <Contents name={file.path} text={file.text} />}
            {!props.readOnly && (
              <Remove label={id} onClick={() => props.remove("surfaces", index)} />
            )}
          </div>
        );
      })}
      {props.edits.contracts.map((name, index) => (
        <div key={name}>
          <Contents
            name={`Contract · ${name}`}
            text={JSON.stringify(
              recipe.contracts?.find((contract) => contract.name === name),
              null,
              2,
            )}
          />
          {!props.readOnly && (
            <Remove label={name} onClick={() => props.remove("contracts", index)} />
          )}
        </div>
      ))}
    </div>
  );
}
