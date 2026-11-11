import type { ClientApi } from "@ace/client";
import type { OutsideAccessRequest } from "@ace/protocol";
import {
  approvalDecision,
  clientTitle,
  initialChoice,
  redirectWords,
  type OutsideChoice,
} from "@ace/ui-core/outside-clients";
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
import { useToast } from "@/components/ui/toast.tsx";
import { useClock } from "@/lib/time.ts";
import { AccessTicks, LifetimeChoice, ProjectsChoice } from "./access-fields.tsx";
import { decideAccess } from "./data/outside.ts";

/**
 * Reviewing an outside client's sign-in (ADR 0117): the match code to check against the
 * client's page, then what it may do, where and for how long. Only read starts ticked; what the
 * client asked for is marked, never chosen for the person. Projects are read from the machine
 * the request is for, so this renders inside that machine's scope.
 */
export function AccessDialog(props: {
  client: ClientApi;
  machine: string;
  request: OutsideAccessRequest;
  onClose(): void;
}) {
  const { request } = props;
  const toast = useToast();
  const clock = useClock();
  const [choice, setChoice] = useState<OutsideChoice>(initialChoice);
  const [pending, setPending] = useState(false);
  const asked = new Set(request.scopes);
  const redirect = redirectWords(request);
  const decide = (approve: boolean) => {
    setPending(true);
    void decideAccess(
      props.client,
      request.requestId,
      approve ? approvalDecision(choice, clock()) : { decision: "deny" },
    )
      .then(props.onClose, (error: unknown) =>
        toast.error({
          title: approve ? "Couldn't approve it" : "Couldn't deny it",
          description:
            error instanceof Error && error.message
              ? error.message
              : `${props.machine} didn't answer.`,
        }),
      )
      .finally(() => setPending(false));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {clientTitle(request.clientName, request.domain)} wants to use {props.machine}
          </DialogTitle>
          <DialogDescription>
            {request.domain
              ? `Approve only if ${request.domain} shows this code.`
              : "Its domain is unverified, so ace can't tell who made it. Approve only if the app you're signing in to shows this code."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {redirect && <p className="text-ui text-muted-foreground">{redirect}</p>}
          <p
            aria-label={`Match code ${request.matchCode}`}
            className="font-mono text-2xl font-semibold tracking-[0.2em] text-foreground tabular-nums"
          >
            {request.matchCode}
          </p>
          <AccessTicks
            scopes={choice.scopes}
            asked={asked}
            onChange={(scopes) => setChoice((now) => ({ ...now, scopes }))}
          />
          <ProjectsChoice
            projects={choice.projects}
            onChange={(projects) => setChoice((now) => ({ ...now, projects }))}
          />
          <LifetimeChoice
            value={choice.lifetime}
            onChange={(lifetime) => setChoice((now) => ({ ...now, lifetime }))}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={() => decide(false)}>
            Deny
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => decide(true)}>
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
