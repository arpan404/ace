import {
  spadeAccountWords,
  spadeChatgptTerms,
  type SpadeSignInFlow,
  type SpadeSignInMethod,
} from "@ace/ui-core/spade-chat";
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  KeyIcon,
} from "@ace/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { BrandMark } from "@/components/ui/provider-icons.tsx";
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
const copiedMs = 1_600;

function useCopy(): [
  state: "idle" | "copied" | "failed",
  copy: (text: string) => Promise<boolean>,
] {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), copiedMs);
      return true;
    } catch {
      setState("failed");
      return false;
    }
  };
  return [state, copy];
}

function openPage(url: string) {
  void openExternal(url).catch(() => window.open(url, "_blank", "noopener"));
}

/**
 * Sign in with ChatGPT (ADR 0214): the person picks a browser on Spade's machine or a code for
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
  const [linkCopied, copyLink] = useCopy();
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
          <DialogTitle className="flex items-center gap-2">
            <BrandMark
              size={20}
              decorative
              choose={() => ({ brand: "openai", label: "ChatGPT" })}
              fallbackLabel="ChatGPT"
            />
            Sign in with ChatGPT
          </DialogTitle>
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
                    icon: <GlobeIcon aria-hidden size={15} />,
                  },
                  {
                    value: "device",
                    label: "With a code",
                    description: "Enter a code on any device, for a Spade with no browser near it.",
                    icon: <KeyIcon aria-hidden size={15} />,
                  },
                ]}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">{spadeChatgptTerms}</p>
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
        <DialogFooter className={shown?.state === "waiting" ? "justify-between" : undefined}>
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
            <>
              {shown.url ? (
                <Button size="sm" variant="ghost" onClick={() => void copyLink(shown.url ?? "")}>
                  {linkCopied === "copied" ? (
                    <CheckIcon aria-hidden size={13} className="text-status-done" />
                  ) : (
                    <CopyIcon aria-hidden size={13} />
                  )}
                  {linkCopied === "copied" ? "Link copied" : "Copy link"}
                </Button>
              ) : (
                <span />
              )}
              <Button variant="ghost" onClick={close}>
                Cancel sign-in
              </Button>
            </>
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

/** Large monospace code tiles matching ace's device-code login challenge. */
function CodeCells(props: { code: string }) {
  return (
    <span aria-label="Code" className="flex items-center gap-1 font-mono">
      {[...props.code].map((char, at) =>
        char === "-" || char === " " ? (
          <span
            // A code's characters never move.
            // oxlint-disable-next-line react/no-array-index-key
            key={at}
            className="w-3 text-center text-lg text-subtle-foreground"
          >
            {char}
          </span>
        ) : (
          <span
            // oxlint-disable-next-line react/no-array-index-key
            key={at}
            className="grid h-11 w-8 place-items-center rounded-sm bg-secondary text-xl font-medium text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
          >
            {char}
          </span>
        ),
      )}
    </span>
  );
}

/** Where the sign-in is: the link (and code) while it waits, then who signed in, or why not. */
function FlowState(props: { flow: SpadeSignInFlow; machine: string }) {
  const { flow } = props;
  const [copied, copyCode] = useCopy();
  if (flow.state === "done")
    return (
      <div className="fx-rise-in flex flex-col items-center gap-2 py-2 text-center">
        <CheckCircleIcon aria-hidden size={28} weight="fill" className="text-status-done" />
        <p className="text-ui font-medium text-foreground">
          {flow.endpoint ? `${spadeAccountWords(flow.endpoint, true)}.` : "Signed in."}
        </p>
      </div>
    );
  if (flow.state === "failed")
    return (
      <p role="alert" className="text-ui text-destructive">
        {flow.error ?? "The sign-in didn't finish."}
      </p>
    );
  if (flow.state === "cancelled") return <p className="text-ui">The sign-in was cancelled.</p>;
  return (
    <div className="fx-rise-in flex flex-col gap-4">
      {flow.method === "device" ? (
        <>
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-md font-medium text-balance text-foreground">
              Enter this code on the sign-in page
            </p>
            <p className="max-w-[44ch] text-ui text-balance text-muted-foreground">
              Go to this page on any device and enter the code.
            </p>
          </div>
          {flow.userCode && (
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => void copyCode(flow.userCode ?? "")}
                className="rounded-md p-1.5 transition-colors duration-(--motion-fast) focus-ring hover:bg-accent"
              >
                <CodeCells code={flow.userCode} />
                <span className="sr-only">Copy code</span>
              </button>
              <p
                role="status"
                className="flex h-5 items-center gap-1 text-xs text-muted-foreground"
              >
                {copied === "copied" ? (
                  <>
                    <CheckIcon aria-hidden size={13} className="text-status-done" /> Copied
                  </>
                ) : copied === "failed" ? (
                  "Couldn't copy. Type the code on the page instead."
                ) : (
                  "Click the code to copy it"
                )}
              </p>
            </div>
          )}
          {flow.url && (
            <div className="flex flex-col gap-1.5 pt-1 *:w-full">
              <a
                href={flow.url}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "primary", size: "lg" })}
                onClick={(event) => {
                  event.preventDefault();
                  // Start the clipboard write before opening the tab: WebKit spends the click's
                  // user activation on open(), and a write begun after it can be refused.
                  if (flow.userCode) void copyCode(flow.userCode);
                  openPage(flow.url ?? "");
                }}
              >
                Copy code and open sign-in page
                <ArrowSquareOutIcon aria-hidden size={14} />
              </a>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-md font-medium text-balance text-foreground">
              Continue in your browser
            </p>
            <p className="max-w-[44ch] text-ui text-balance text-muted-foreground">
              {`Open this link in a browser on ${props.machine} and sign in.`}
            </p>
          </div>
          {flow.url && (
            <div className="flex flex-col gap-1.5 pt-1 *:w-full">
              <a
                href={flow.url}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "primary", size: "lg" })}
                onClick={(event) => {
                  event.preventDefault();
                  openPage(flow.url ?? "");
                }}
              >
                Open sign-in page
                <ArrowSquareOutIcon aria-hidden size={14} />
              </a>
            </div>
          )}
        </>
      )}
      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <span aria-hidden className="relative grid size-2 place-items-center">
          <span className="fx-ring absolute inset-0 rounded-full bg-status-working" />
          <span className="size-1.5 rounded-full bg-status-working" />
        </span>
        <span className="shimmer">Waiting for the sign-in…</span>
      </p>
    </div>
  );
}
