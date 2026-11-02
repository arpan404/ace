import type { MachineAccountStatus } from "@ace/protocol";
import { MachineCode } from "@ace/protocol";
import { formatShortClock } from "@ace/ui-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useNow } from "@/lib/time.ts";
import { useAceAccount, useAceAccountStore } from "./account-context.tsx";
import { machineAccountRow, machineCodeSentence } from "./machine-account-copy.ts";

/** A machine's ace account and machine code: read, sign in or out, set or clear the code. */
export interface MachineAccountAccess {
  /** Undefined from a daemon too old to have ace accounts. */
  status(): Promise<MachineAccountStatus | undefined>;
  /** Signs the machine in with this app's session. */
  signIn(origin: string, token: string): Promise<MachineAccountStatus>;
  signOut(): Promise<MachineAccountStatus>;
  setCode(code: string): Promise<MachineAccountStatus>;
  clearCode(): Promise<MachineAccountStatus>;
}

const statusKey = (machine: string) => ["ace-account", "machine", machine] as const;

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
}) {
  const queryClient = useQueryClient();
  const key = statusKey(props.machine);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => (await props.access.status()) ?? null,
    retry: false,
  });
  const write = (next: MachineAccountStatus) => queryClient.setQueryData(key, next);
  const status = query.data;
  if (query.isError)
    return (
      <SettingSection label="ace account" anchor="ace-account">
        <SettingNote role="alert">
          Couldn't read this machine's account. Reconnect and try again.
        </SettingNote>
      </SettingSection>
    );
  if (!status) return null;
  return (
    <>
      {props.local && <ThisMachineAccount status={status} access={props.access} onChange={write} />}
      <MachineCodeSetting status={status} access={props.access} onChange={write} />
    </>
  );
}

function ThisMachineAccount(props: {
  status: MachineAccountStatus;
  access: MachineAccountAccess;
  onChange(next: MachineAccountStatus): void;
}) {
  const store = useAceAccountStore();
  const { session } = useAceAccount();
  const row = machineAccountRow(props.status, session?.account);
  const change = useMutation({
    mutationFn: (op: "signIn" | "signOut") => {
      if (op === "signOut") return props.access.signOut();
      if (!store || !session) throw new Error("Sign in to your ace account under Profile first.");
      return props.access.signIn(store.origin, session.token);
    },
    onSuccess: props.onChange,
  });
  return (
    <SettingSection label="ace account" anchor="ace-account">
      <SettingRow id="machine.account" title="This machine" description={row.sentence} inline>
        {row.action === "appFirst" && (
          <Button size="sm" variant="ghost" render={<Link to="/settings/general" />}>
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
    </SettingSection>
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
    <SettingSection label="Machine code" anchor="machine-code">
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
          aria-label="New machine code"
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
    </SettingSection>
  );
}
