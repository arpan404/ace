import type { SpadeWorkerNode } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";

/** A bot with workers, held for the one question its delete asks. */
export interface DeletingMaker {
  name: string;
  /** The bots it made: they become the person's own either way. */
  workers: readonly SpadeWorkerNode[];
  /** It started ace agents, which Stop stops too. */
  aceAgents: boolean;
  run(workers: "stop" | "keep"): void;
}

const listed = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

/**
 * Deleting a bot that made workers asks one thing: stop its workers, or keep them going. Either
 * way they stay as the person's own bots; nothing is deleted that wasn't named (ADR 0161).
 */
export function DeleteMakerDialog(props: { deleting: DeletingMaker | undefined; onDone(): void }) {
  const [shown, setShown] = useState(props.deleting);
  if (props.deleting && props.deleting !== shown) setShown(props.deleting);
  const deleting = props.deleting ?? shown;
  const [choice, setChoice] = useState<"stop" | "keep">("stop");
  const names = listed(deleting?.workers.map((worker) => worker.name) ?? []);
  const own = (deleting?.workers.length ?? 0) === 1 ? "stays as your bot" : "stay as your bots";
  const choices = [
    {
      value: "stop" as const,
      label: "Stop its workers",
      detail: `${names} ${own}, stopped.${deleting?.aceAgents ? " Its ace threads stop." : ""}`,
    },
    {
      value: "keep" as const,
      label: "Keep its workers going",
      detail: "They carry on as your own bots.",
    },
  ];
  return (
    <Dialog open={props.deleting !== undefined} onOpenChange={(open) => !open && props.onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {deleting?.name}?</DialogTitle>
          <DialogDescription className="sr-only">
            Choose what happens to its workers.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          aria-label="Its workers"
          value={choice}
          onValueChange={(value) => setChoice(value === "keep" ? "keep" : "stop")}
          className="gap-3"
        >
          {choices.map((each) => (
            <label key={each.value} className="flex cursor-pointer items-start gap-3">
              <RadioGroupItem value={each.value} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-ui font-medium text-foreground">{each.label}</span>
                <span className="text-ui text-muted-foreground">{each.detail}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onDone}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              props.deleting?.run(choice);
              props.onDone();
            }}
          >
            Delete {deleting?.name}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
