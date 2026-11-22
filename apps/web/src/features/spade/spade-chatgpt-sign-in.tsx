import {
  spadeAccountWords,
  spadeChatgptTerms,
  type SpadeSignInFlow,
  type SpadeSignInMethod,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import {
  cancelChatgptSignIn,
  readChatgptSignIn,
  startChatgptSignIn,
} from "./spade-accounts-api.ts";
import { SpadeChoices } from "./spade-choices.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-settings-rows.tsx";
import { modelsKey } from "./use-spade-models.ts";

/** How often a waiting sign-in is read again. */
const signInPoll = 1_000;

/**
 * Sign in with ChatGPT (ADR 0213): the person picks a browser on Spade's machine or a code for
 * any device, reads the one sentence on OpenAI's terms, and only then does the sign-in start.
 * Then the link (and code) to use, read again until Spade says it ended. `account` signs a
 * signed-out account back in.
 */
export function ChatgptSignInDialog(props: { account?: string | undefined; onClose(): void }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const machine = useSpadeMachine();
  const [method, setMethod] = useState<SpadeSignInMethod>("browser");
  const [flow, setFlow] = useState<SpadeSignInFlow>();
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string>();
  const live = useFlow(flow);
  const shown = live ?? flow;
  const ended = shown?.state === "done" || shown?.state === "failed";
  useEffect(() => {
    if (shown?.state === "done") void cache.invalidateQueries({ queryKey: modelsKey });
  }, [shown?.state, cache]);
  const start = async () => {
    setStarting(true);
    setProblem(undefined);
    try {
      setFlow(await startChatgptSignIn(client, method, props.account));
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setStarting(false);
    }
  };
  const close = () => {
    // A sign-in left waiting is cancelled, so its callback port and code don't linger.
    if (shown?.state === "waiting") void cancelChatgptSignIn(client, shown.id).catch(() => {});
    props.onClose();
  };
  const again = () => {
    setFlow(undefined);
    setProblem(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign in with ChatGPT</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {!shown ? (
            <>
              <SpadeChoices<SpadeSignInMethod>
                label="How to sign in"
                value={method}
                onChange={setMethod}
                choices={[
                  {
                    value: "browser",
                    label: "In a browser",
                    description: `Opens OpenAI's sign-in in a browser on ${machineWords(machine)}.`,
                  },
                  {
                    value: "device",
                    label: "With a code",
                    description: "Enter a code on any device, for a Spade with no browser near it.",
                  },
                ]}
              />
              <p className="text-ui text-muted-foreground">{spadeChatgptTerms}</p>
            </>
          ) : (
            <FlowState flow={shown} machine={machineWords(machine)} />
          )}
          {problem && (
            <p role="alert" className="text-ui text-destructive">
              {problem}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          {!shown && (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" disabled={starting} onClick={() => void start()}>
                {starting ? "Starting…" : "Continue"}
              </Button>
            </>
          )}
          {shown?.state === "waiting" && (
            <Button variant="ghost" onClick={close}>
              Cancel sign-in
            </Button>
          )}
          {shown?.state === "failed" && (
            <Button variant="ghost" onClick={again}>
              Try again
            </Button>
          )}
          {(ended || shown?.state === "cancelled") && (
            <Button variant="primary" onClick={props.onClose}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "this computer", or the machine Spade runs on by its name. */
const machineWords = (machine: { primary: boolean; name: string }) =>
  machine.primary ? "this computer" : machine.name;

/** The sign-in read again while it waits; undefined before it starts. */
function useFlow(flow: SpadeSignInFlow | undefined) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  return useQuery({
    queryKey: [...modelsKey, machine, "sign-in", flow?.id ?? ""],
    queryFn: ({ signal }) => readChatgptSignIn(client, flow?.id ?? "", signal),
    enabled: flow !== undefined,
    refetchInterval: (query) =>
      (query.state.data ?? flow)?.state === "waiting" ? signInPoll : false,
    retry: false,
  }).data;
}

/** Where the sign-in is: the link (and code) while it waits, then who signed in, or why not. */
function FlowState(props: { flow: SpadeSignInFlow; machine: string }) {
  const { flow } = props;
  if (flow.state === "done")
    return (
      <p className="text-ui">
        {flow.endpoint ? `${spadeAccountWords(flow.endpoint, true)}.` : "Signed in."}
      </p>
    );
  if (flow.state === "failed")
    return (
      <p role="alert" className="text-ui text-destructive">
        {flow.error ?? "The sign-in didn't finish."}
      </p>
    );
  if (flow.state === "cancelled") return <p className="text-ui">The sign-in was cancelled.</p>;
  const link = flow.url && (
    <a
      href={flow.url}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-ui break-all underline underline-offset-2"
    >
      {flow.url}
    </a>
  );
  return (
    <div className="flex flex-col gap-3">
      {flow.method === "device" ? (
        <>
          <p className="text-ui">Go to this page on any device and enter the code.</p>
          {link}
          <p
            aria-label="Code"
            className="font-mono text-2xl font-semibold tracking-widest select-all"
          >
            {flow.userCode}
          </p>
        </>
      ) : (
        <>
          <p className="text-ui">{`Open this link in a browser on ${props.machine} and sign in.`}</p>
          {link}
        </>
      )}
      <p className="text-xs text-muted-foreground">Waiting for the sign-in…</p>
    </div>
  );
}
