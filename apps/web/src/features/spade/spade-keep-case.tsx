import type { SpadeCaseMark } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { casesKey, keepCase, reviewCase } from "./spade-cases-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";

/*
 * Keep as a test (ADR 0204 §1): the person keeps one finished reply of a bot as a test case.
 * Before anything is written they see what will be kept, as Spade will keep it (secrets, their
 * addresses and their name already hidden), mark it right or wrong with a line of why, and may
 * mark more to hide. Nothing leaves the machine.
 */

const marks: readonly { value: SpadeCaseMark; label: string }[] = [
  { value: "right", label: "This was right" },
  { value: "wrong", label: "This was wrong" },
];

export function KeepCaseDialog(props: {
  bot: { id: string; name: string };
  /** The reply being kept; undefined while the dialog is closed. */
  reply: string | undefined;
  onDone(): void;
}) {
  const [shown, setShown] = useState(props.reply);
  if (props.reply && props.reply !== shown) setShown(props.reply);
  const reply = props.reply ?? shown;
  return (
    <Dialog open={props.reply !== undefined} onOpenChange={(open) => !open && props.onDone()}>
      <DialogContent>
        {reply && (
          <KeepCaseForm key={reply} bot={props.bot} reply={reply} onDone={props.onDone} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function KeepCaseForm(props: { bot: { id: string; name: string }; reply: string; onDone(): void }) {
  const { bot, reply } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const toast = useToast();
  const [mark, setMark] = useState<SpadeCaseMark>();
  const [why, setWhy] = useState("");
  const [hide, setHide] = useState<readonly string[]>([]);
  const [hiding, setHiding] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const review = useQuery({
    queryKey: ["spade", "case-review", machine, bot.id, reply, hide],
    queryFn: ({ signal }) => reviewCase(client, bot.id, { reply, hide }, signal),
    retry: false,
  });
  const addHidden = () => {
    const value = hiding.trim();
    if (value.length < 2 || hide.includes(value)) return;
    setHide([...hide, value]);
    setHiding("");
  };
  const keep = async () => {
    setSaving(true);
    setProblem(undefined);
    try {
      await keepCase(client, bot.id, { reply, mark, why, hide });
      await cache.invalidateQueries({ queryKey: casesKey(machine, bot.id) });
      toast.info({
        title: "Kept as a test",
        description: `It's in ${bot.name}'s profile.`,
      });
      props.onDone();
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Keep as a test</DialogTitle>
        <DialogDescription>
          Kept on this machine with {bot.name}, never sent anywhere. Secrets, your addresses and
          your name are hidden.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <RadioGroup
          aria-label="How it went"
          value={mark ?? null}
          onValueChange={(value) => setMark(value === "wrong" ? "wrong" : "right")}
          className="gap-2"
        >
          {marks.map((each) => (
            <label key={each.value} className="flex cursor-pointer items-center gap-3">
              <RadioGroupItem value={each.value} />
              <span className="text-ui text-foreground">{each.label}</span>
            </label>
          ))}
        </RadioGroup>
        <Input
          aria-label="Why"
          placeholder="Why, in a line (optional)"
          value={why}
          maxLength={280}
          onChange={(event) => setWhy(event.target.value)}
        />
        <section aria-label="What it keeps" className="flex flex-col gap-2">
          <h3 className="text-ui font-medium text-muted-foreground">What it keeps</h3>
          {review.isError ? (
            <p role="alert" className="text-ui text-muted-foreground">
              {fault(review.error)}
            </p>
          ) : !review.data ? (
            <p className="text-ui text-muted-foreground">Reading the run…</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {review.data.map((line) => (
                <li key={line.key} className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">{line.label}</span>
                  <span className="line-clamp-3 text-ui break-words whitespace-pre-wrap text-foreground">
                    {line.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            addHidden();
          }}
        >
          <Input
            aria-label="Something else to hide"
            placeholder="Something else to hide"
            value={hiding}
            onChange={(event) => setHiding(event.target.value)}
          />
          <Button type="submit" size="sm" variant="ghost" disabled={hiding.trim().length < 2}>
            Hide
          </Button>
        </form>
        {hide.length > 0 && (
          <ul aria-label="Hidden" className="flex flex-col gap-1">
            {hide.map((value) => (
              <li key={value} className="flex items-center gap-2 text-ui">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  Hiding “{value}”
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Stop hiding ${value}`}
                  onClick={() => setHide(hide.filter((each) => each !== value))}
                >
                  Show
                </Button>
              </li>
            ))}
          </ul>
        )}
        {problem && (
          <p role="alert" className="text-ui text-destructive">
            {problem}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={props.onDone}>
          Cancel
        </Button>
        <Button disabled={saving || !review.data} onClick={() => void keep()}>
          {saving ? "Keeping…" : "Keep as a test"}
        </Button>
      </DialogFooter>
    </>
  );
}
