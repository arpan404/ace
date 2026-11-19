import { useId, useState, type FormEvent } from "react";
import type { AntigravitySignIn, AntigravitySignInMethod } from "@ace/protocol";
import {
  antigravitySignIn,
  antigravitySignInMethods,
  googleSignIn,
  type AntigravityMethodDraft,
} from "@ace/ui-core";

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
import { Select } from "@/components/ui/select.tsx";
import { useAccountViews } from "@/lib/account-views.ts";

export { antigravitySignIn, googleSignIn, type AntigravityMethodDraft };

/*
 * How an Antigravity account signs in: its Google account, Gemini Enterprise in the browser, or
 * Agent Platform with the Application Default Credentials already on the computer running ace.
 * The cloud methods name a Google Cloud project and location, which ace writes to that
 * account's own Antigravity settings. Key-based methods aren't offered.
 */

export function AntigravityMethodFields(props: {
  value: AntigravityMethodDraft;
  onChange(value: AntigravityMethodDraft): void;
}) {
  const projectId = useId();
  const locationId = useId();
  const cloud = antigravitySignInMethods.find(
    (entry) => entry.method === props.value.method,
  )?.cloud;
  return (
    <div className="flex flex-col gap-2">
      <Select<AntigravitySignInMethod>
        label="Sign in with"
        value={props.value.method}
        options={antigravitySignInMethods.map((entry) => ({
          value: entry.method,
          label: entry.label,
        }))}
        onValueChange={(method) => props.onChange({ ...props.value, method })}
      />
      {cloud && (
        <>
          <label htmlFor={projectId} className="text-sm">
            Project ID
          </label>
          <Input
            id={projectId}
            placeholder="my-project-123"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            value={props.value.project}
            onChange={(event) => props.onChange({ ...props.value, project: event.target.value })}
          />
          <label htmlFor={locationId} className="text-sm">
            Location
          </label>
          <Input
            id={locationId}
            placeholder={props.value.method === "enterprise" ? "global" : "us-central1"}
            autoComplete="off"
            spellCheck={false}
            maxLength={63}
            value={props.value.location}
            onChange={(event) => props.onChange({ ...props.value, location: event.target.value })}
          />
          {props.value.method === "agent_platform" && (
            <p className="text-sm text-muted-foreground">
              Uses gcloud's Application Default Credentials on the computer running ace.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Choose how to sign in again, before the sign-in starts. Opens on the account's current method. */
export function AntigravityMethodDialog(props: {
  instance: string | undefined;
  onContinue(signIn: AntigravitySignIn): void;
  onClose(): void;
}) {
  const accounts = useAccountViews();
  const current = accounts.data?.find(
    (account) => account.id === (props.instance ?? "antigravity-cli-default"),
  )?.antigravitySignIn;
  const [draft, setDraft] = useState<AntigravityMethodDraft>();
  const [problem, setProblem] = useState<string>();
  const value = draft ?? { ...googleSignIn, method: current ?? "google" };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const chosen = antigravitySignIn(value);
    if ("problem" in chosen) return setProblem(chosen.problem);
    props.onContinue(chosen.signIn);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <form aria-label="Choose how to sign in" onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Sign in to Antigravity</DialogTitle>
            <DialogDescription>Choose how this account signs in.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <AntigravityMethodFields value={value} onChange={setDraft} />
            {problem && (
              <p role="alert" className="pt-2 text-sm text-status-failed">
                {problem}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
