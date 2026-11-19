import type { MachineCodeGate } from "@ace/client";
import { MachineCode } from "@ace/protocol";
import { useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useSeconds } from "@/lib/time.ts";
import { machineCodePrompt } from "./machine-code-copy.ts";

/** What the prompt needs of `machineCodeGate` (`@ace/client`). */
export type CodeGate = Pick<MachineCodeGate, "asking" | "enter" | "subscribe">;

/**
 * Asks for a machine's code where the machine is being opened, while its daemon wants one: one
 * sentence, the field and Unlock. The code goes into the gate, which sends it with the next
 * connection (`onEntered` opens it). Renders nothing while the machine isn't asking.
 */
export function MachineCodePrompt(props: {
  gate: CodeGate;
  machine: string;
  /** When a locked machine takes codes again, if known (its daemon status). */
  lockedUntil?: number | undefined;
  onEntered(): void;
}) {
  const { gate } = props;
  const asking = useSyncExternalStore(gate.subscribe, () => gate.asking);
  const now = useSeconds(asking === "machine_code_locked" && props.lockedUntil !== undefined);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState("");
  const id = useId();
  if (!asking) return null;
  const prompt = machineCodePrompt(asking, props.machine, props.lockedUntil, now);
  const submit = () => {
    if (!MachineCode.safeParse(code).success) {
      setProblem("A machine code has at least 4 characters.");
      return;
    }
    gate.enter(code);
    setCode("");
    setProblem("");
    props.onEntered();
  };
  return (
    <form
      aria-label={`Machine code for ${props.machine}`}
      className="flex flex-col gap-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p id={id} role="status" className="text-sm text-foreground">
        {problem || prompt.sentence}
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Machine code"
          aria-describedby={id}
          type="password"
          autoComplete="off"
          autoFocus
          maxLength={128}
          className="w-52"
          disabled={!prompt.open}
          value={code}
          onChange={(event) => setCode(event.currentTarget.value)}
        />
        <Button type="submit" size="sm" disabled={!prompt.open || code.length === 0}>
          Unlock
        </Button>
      </div>
    </form>
  );
}
