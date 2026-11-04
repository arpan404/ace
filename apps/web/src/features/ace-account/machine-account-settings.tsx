import type { MachineAccountStatus } from "@ace/protocol";
import { MachineCode } from "@ace/protocol";
import { formatShortClock } from "@ace/ui-core";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useNow } from "@/lib/time.ts";
import { machineCodeSentence } from "./machine-account-copy.ts";
import {
  useMachineAccountStatus,
  useThisMachineAccount,
  type MachineAccountAccess,
} from "./machine-account-state.ts";

export type { MachineAccountAccess };

/**
 * A machine's page in Settings, for ace accounts (ADR 0111): whether the machine is signed in to
 * the account (only for this computer's own daemon, which the app can sign in and out) and its
 * machine code. Nothing on a daemon without accounts.
 */
export function MachineAccountSections(props: {
  machine: string;
  access: MachineAccountAccess;
  /** This computer's daemon: its own account can be signed in and out from here. */
  local: boolean;
  /** The section's heading; "ace account" on a machine's page. */
  label?: string;
}) {
  const label = props.label ?? "ace account";
  const { query, write } = useMachineAccountStatus(props.machine, props.access);
  const status = query.data;
  if (query.isError)
    return (
      <SettingSection label={label} anchor="ace-account">
        <SettingNote role="alert">
          Couldn't read this machine's account. Reconnect and try again.
        </SettingNote>
      </SettingSection>
    );
  if (!status) return null;
  return (
    <SettingSection label={label} anchor="ace-account">
      {props.local && <ThisMachineAccount status={status} access={props.access} onChange={write} />}
      <MachineCodeSetting status={status} access={props.access} onChange={write} />
    </SettingSection>
  );
}

function ThisMachineAccount(props: {
  status: MachineAccountStatus;
  access: MachineAccountAccess;
  onChange(next: MachineAccountStatus): void;
}) {
  const { row, change } = useThisMachineAccount(props.status, props.access, props.onChange);
  if (!row) return null;
  return (
    <>
      <SettingRow id="machine.account" title="ace account" description={row.sentence} inline>
        {row.action === "appFirst" && (
          <Button
            size="sm"
            variant="ghost"

            render={<Link to="/settings/profile" />}
          >
            Open Profile
          </Button>
        )}
        {(row.action === "signIn" || row.action === "switch") && (
          <Button size="sm" disabled={change.isPending} onClick={() => change.mutate("signIn")}>
            {row.action === "switch" ? "Use this app's account" : "Sign in"}
          </Button>
        )}
        {(row.action === "signOut" || row.action === "switch") && (
          <Button
            size="sm"
            variant="ghost"
            disabled={change.isPending}
            onClick={() => change.mutate("signOut")}
          >
            Sign out
          </Button>
        )}
      </SettingRow>
      {change.isError && (
        <SettingNote role="alert" className="text-destructive">
          {change.error.message}
        </SettingNote>
      )}
    </>
  );
}

function MachineCodeSetting(props: {
  status: MachineAccountStatus;
  access: MachineAccountAccess;
  onChange(next: MachineAccountStatus): void;
}) {
  const { machineCode } = props.status;
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState("");
  const change = useMutation({
    mutationFn: (next: string | null) =>
      next === null ? props.access.clearCode() : props.access.setCode(next),
    onSuccess: (next) => {
      props.onChange(next);
      setEditing(false);
      setCode("");
    },
  });
  const save = () => {
    if (!MachineCode.safeParse(code).success) {
      setProblem("A machine code has 4 to 128 characters.");
      return;
    }
    setProblem("");
    change.mutate(code);
  };
  const locked = machineCode.lockedUntil !== undefined && machineCode.lockedUntil > now;
  return (
    <>
      <SettingRow id="machine.code" title="Machine code" description={machineCodeSentence} inline>
        {!editing && (
          <>
            <span className="text-xs text-subtle-foreground">
              {machineCode.set ? "Set" : "Not set"}
            </span>
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {machineCode.set ? "Change" : "Set code"}
            </Button>
            {machineCode.set && (
              <Button
                size="sm"
                variant="ghost"
                tone="danger"
                disabled={change.isPending}
                onClick={() => change.mutate(null)}
              >
                Clear
              </Button>
            )}
          </>
        )}
      </SettingRow>
      {editing && (
        <form
          aria-label="Change machine code"
          data-setting-slot=""
          className="flex items-center gap-2 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Input
            aria-label="New machine code"
            type="password"
            autoComplete="new-password"
            autoFocus
            maxLength={128}
            className="w-52"
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
          />
          <Button type="submit" size="sm" variant="primary" disabled={change.isPending || !code}>
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setCode("");
              setProblem("");
            }}
          >
            Cancel
          </Button>
        </form>
      )}
      {locked && machineCode.lockedUntil !== undefined && (
        <SettingNote>
          Too many wrong codes. Code entry is paused until{" "}
          {formatShortClock(machineCode.lockedUntil)}.
        </SettingNote>
      )}
      {(problem || change.isError) && (
        <SettingNote role="alert" className="text-destructive">
          {problem || change.error?.message}
        </SettingNote>
      )}
    </>
  );
}
