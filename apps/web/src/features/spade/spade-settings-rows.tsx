import { spadeStateLine } from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { SettingCard, SettingNote, SettingRow } from "@/components/setting-row.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

/*
 * What Settings › Spade's pages share: whether Spade runs here, what a page says while it
 * doesn't, a part that couldn't be read, and a row that picks one model.
 */

export const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * Whether Spade runs on this machine, as its pages need it: `ready` once it answers, `reading`
 * while that isn't known yet (the page's parts hold their place).
 */
export function useSpadeRunning() {
  const status = useSpadeStatus();
  const [enabled, setEnabled, saving] = useSpadeEnabled();
  const line = spadeStateLine(status, enabled);
  const reading = !line.ready && (enabled === undefined || status === undefined);
  return { status, enabled, setEnabled, saving, line, reading };
}

/** A page that needs Spade while it isn't running: its state, once, and the way to turn it on. */
export function SpadeNotRunning(props: { sentence: string; canTurnOn: boolean }) {
  return (
    <SettingCard>
      <SettingNote className="flex flex-wrap items-center justify-between gap-2">
        <span>{props.sentence}</span>
        {props.canTurnOn && (
          <Link to="/settings/spade" className={buttonVariants({ size: "sm", variant: "ghost" })}>
            Turn on in General
          </Link>
        )}
      </SettingNote>
    </SettingCard>
  );
}

/** A part of a page Spade couldn't answer for: what, why, and Try again. */
export function CouldNotRead(props: { what: string; error: Error; retry(): void }) {
  return (
    <SettingRow title={`Couldn't read ${props.what}`} description={props.error.message}>
      <Button size="sm" onClick={props.retry}>
        Try again
      </Button>
    </SettingRow>
  );
}

/** A refusal under the control it came from. */
export function Refusal(props: { children: ReactNode }) {
  return (
    <span role="alert" className="text-destructive">
      {props.children}
    </span>
  );
}

/**
 * A setting that is one model: the row's title, a short line only where the name isn't enough,
 * and the one model picker. `none` is the empty choice's words ("Each bot's own"), saved as
 * null. A refused change says why under the title and the picker goes back to what is saved.
 */
export function ModelSettingRow(props: {
  title: string;
  description?: ReactNode;
  value: string | undefined;
  none?: string | undefined;
  /** What the empty choice comes to, shown while it is chosen (`SpadeModelPicker`). */
  follows?: string | undefined;
  /** The picker beside the title at every width, as a bot's profile has it. */
  inline?: boolean;
  save(model: string | null): Promise<unknown>;
}) {
  const id = useId();
  const [refusal, setRefusal] = useState<string>();
  const [pending, setPending] = useState<string>();
  const shown = pending ?? props.value ?? "";
  const choose = async (value: string) => {
    setRefusal(undefined);
    setPending(value);
    try {
      await props.save(value || null);
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setPending(undefined);
    }
  };
  return (
    <SettingRow
      title={props.title}
      description={refusal ? <Refusal>{refusal}</Refusal> : props.description}
      htmlFor={id}
      density="compact"
      inline={props.inline === true}
    >
      <SpadeModelPicker
        id={id}
        label={props.title}
        value={shown}
        none={props.none}
        follows={props.follows}
        onChange={(value) => void choose(value)}
      />
    </SettingRow>
  );
}
