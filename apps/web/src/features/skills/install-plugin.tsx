import { PlusIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button.tsx";
import type { PluginListing } from "@ace/protocol";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { PluginReviewStep } from "./plugin-review.tsx";
import {
  PluginNameInput,
  PluginRef,
  PluginRepository,
  pluginSkillId,
  sourceText,
  suggestedPluginName,
  type PluginPin,
} from "./skills-model.ts";
import {
  useCancelReview,
  useMarketplace,
  usePreparePlugin,
  useUpdatePlugin,
  type PreparedPlugin,
} from "./skills-source.ts";

const failure = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

interface SourceForm {
  repository: string;
  /** Empty: the repository's default branch. */
  ref: string;
  /** The plugin picked from the listing, or typed when the listing isn't available. */
  name: string;
  listing?: { ref: string; plugins: readonly PluginListing[] } | undefined;
  /** The daemon couldn't list the marketplace; the name is typed. */
  manual?: boolean;
}
const emptyForm: SourceForm = { repository: "", ref: "", name: "" };

/** What the dialog shows: the source form, an update being fetched, or a review. */
type Step =
  | { kind: "source" }
  | { kind: "updating"; plugin: string; pin: PluginPin | undefined }
  | {
      kind: "review";
      prepared: PreparedPlugin;
      from: string | undefined;
      back: "source" | "close";
    };

interface InstallDialog {
  /** Open the install form. */
  install(): void;
  /** Fetch `plugin` again and review the new pin. */
  update(plugin: string, pin: PluginPin | undefined): void;
}

const InstallDialogContext = createContext<InstallDialog | null>(null);

export function useInstallDialog(): InstallDialog {
  const dialog = use(InstallDialogContext);
  if (!dialog) throw new Error("useInstallDialog needs <InstallDialogProvider>");
  return dialog;
}

/**
 * The one Install / Update dialog for Skills, opened from the sidebar's "+", the empty main
 * pane or a plugin's ⋯ menu. The daemon fetches the repository and pins the plugin for review;
 * nothing it ships runs until you accept exactly what the review shows.
 */
export function InstallDialogProvider(props: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "source" });
  const [form, setForm] = useState<SourceForm>(emptyForm);
  const cancel = useCancelReview();
  const dropPin = (current: Step) => {
    if (current.kind === "review") cancel.mutate(current.prepared.review.id);
  };
  const close = () => {
    // Closing during review drops the pin, so the daemon doesn't keep it.
    dropPin(step);
    setOpen(false);
  };
  const api = useMemo<InstallDialog>(
    () => ({
      install: () => {
        setStep({ kind: "source" });
        setForm(emptyForm);
        setOpen(true);
      },
      update: (plugin, pin) => {
        setStep({ kind: "updating", plugin, pin });
        setOpen(true);
      },
    }),
    [],
  );
  const navigate = useNavigate();
  const toast = useToast();
  const installed = async (name: string) => {
    toast.add({ title: `Installed ${name}` });
    setOpen(false);
    await navigate({ to: "/skills/$skillId", params: { skillId: pluginSkillId(name) } });
  };
  return (
    <InstallDialogContext value={api}>
      {props.children}
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent size={step.kind === "review" ? "md" : "sm"}>
          {step.kind === "source" ? (
            <SourceStep
              form={form}
              onChange={setForm}
              onCancel={close}
              onPrepared={(prepared, from) =>
                setStep({ kind: "review", prepared, from, back: "source" })
              }
            />
          ) : step.kind === "updating" ? (
            <UpdateStep
              plugin={step.plugin}
              pin={step.pin}
              onCancel={close}
              onUpToDate={(prepared) => {
                cancel.mutate(prepared.review.id);
                toast.add({ title: `${step.plugin} is up to date` });
                setOpen(false);
              }}
              onPrepared={(prepared) =>
                setStep({
                  kind: "review",
                  prepared,
                  from: step.pin?.repository
                    ? sourceText(step.pin.repository, step.pin.ref)
                    : undefined,
                  back: "close",
                })
              }
            />
          ) : (
            <PluginReviewStep
              prepared={step.prepared}
              from={step.from}
              onBack={() => {
                dropPin(step);
                if (step.back === "close") setOpen(false);
                else setStep({ kind: "source" });
              }}
              onInstalled={installed}
            />
          )}
        </DialogContent>
      </Dialog>
    </InstallDialogContext>
  );
}

/** "+" in the Skills header. */
export function InstallPluginButton() {
  const dialog = useInstallDialog();
  return <IconButton icon={PlusIcon} label="Install plugin" onClick={dialog.install} />;
}

function Field(props: {
  label: string;
  value: string;
  placeholder: string;
  readOnly: boolean;
  onChange(value: string): void;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-muted-foreground">
        {props.label}
      </label>
      <Input
        id={id}
        value={props.value}
        readOnly={props.readOnly}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        spellCheck={false}
        autoComplete="off"
        className="font-mono text-sm"
      />
    </div>
  );
}

/**
 * Where the plugin comes from. Find plugins reads the repository's marketplace and lists what
 * it offers to pick from; a daemon that can't list it takes the plugin's name typed instead.
 * The form keeps its values when a review goes Back.
 */
function SourceStep(props: {
  form: SourceForm;
  onChange(form: SourceForm): void;
  onCancel(): void;
  onPrepared(prepared: PreparedPlugin, from: string): void;
}) {
  const { form } = props;
  const [error, setError] = useState<string>();
  const prepare = usePreparePlugin();
  const marketplace = useMarketplace();
  const abort = useRef<AbortController>(null);
  // Leaving the step (closing the dialog) stops a fetch still in flight.
  useEffect(() => () => abort.current?.abort(), []);
  const listed = form.listing;
  const set = (patch: Partial<SourceForm>) => props.onChange({ ...form, ...patch });
  // A new repository or ref is a new listing.
  const setSource = (patch: Partial<SourceForm>) =>
    props.onChange({ ...form, ...patch, listing: undefined, name: "", manual: false });
  const source = () => {
    const repository = PluginRepository.safeParse(form.repository);
    const ref = form.ref.trim() ? PluginRef.safeParse(form.ref) : undefined;
    if (!repository.success || (ref && !ref.success)) {
      setError((repository.error ?? ref?.error)?.issues[0]?.message);
      return undefined;
    }
    return { repository: repository.data, ref: ref?.data };
  };
  const run = async <T,>(work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    setError(undefined);
    const controller = new AbortController();
    abort.current = controller;
    try {
      return await work(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) throw reason;
      return undefined;
    }
  };
  const find = async () => {
    const where = source();
    if (!where) return;
    try {
      const found = await run((signal) => marketplace.mutateAsync({ ...where, signal }));
      if (!found) return;
      const only = found.plugins.length === 1 ? found.plugins[0]?.name : undefined;
      props.onChange({ ...form, listing: found, name: only ?? "", manual: false });
      if (!found.plugins.length) setError("This repository's marketplace lists no plugins.");
    } catch (reason) {
      // An older daemon can't list a marketplace: the plugin's name can still be typed.
      setError(failure(reason, "The daemon couldn't read that repository's marketplace."));
      set({ manual: true, name: form.name || suggestedPluginName(form.repository) });
    }
  };
  const review = async () => {
    const where = source();
    const plugin = PluginNameInput.safeParse(form.name);
    if (!where) return;
    if (!plugin.success) {
      setError(plugin.error.issues[0]?.message);
      return;
    }
    const ref = listed?.ref ?? where.ref ?? "HEAD";
    try {
      const prepared = await run((signal) =>
        prepare.mutateAsync({ repository: where.repository, ref, name: plugin.data, signal }),
      );
      if (prepared) props.onPrepared(prepared, sourceText(form.repository.trim(), ref));
    } catch (reason) {
      setError(failure(reason, "The daemon couldn't fetch that plugin."));
    }
  };
  const stop = () => {
    abort.current?.abort();
    prepare.reset();
    marketplace.reset();
  };
  const fetching = prepare.isPending || marketplace.isPending;
  const choosing = listed !== undefined || form.manual;
  return (
    <form
      noValidate
      className="flex min-h-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (fetching) return;
        void (choosing ? review() : find());
      }}
    >
      <DialogHeader>
        <DialogTitle>Install a plugin</DialogTitle>
        <DialogDescription>
          ace reads the repository's marketplace, and shows you what a plugin runs before anything
          is enabled.
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Repository"
          value={form.repository}
          placeholder="getsentry/sentry-mcp"
          readOnly={fetching}
          onChange={(repository) => setSource({ repository })}
        />
        <Field
          label="Branch or tag"
          value={form.ref}
          placeholder="Default branch"
          readOnly={fetching}
          onChange={(ref) => setSource({ ref })}
        />
      </div>
      {listed && listed.plugins.length > 0 && (
        <DialogBody>
          <div role="radiogroup" aria-label="Plugins in this marketplace" className="grid gap-1">
            {listed.plugins.map((plugin) => (
              <label
                key={plugin.name}
                className="flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent"
              >
                <input
                  type="radio"
                  name="plugin"
                  value={plugin.name}
                  checked={form.name === plugin.name}
                  disabled={fetching}
                  onChange={() => set({ name: plugin.name })}
                  className="mt-1 accent-(--ring)"
                />
                <span className="min-w-0">
                  <span className="block font-mono text-sm text-foreground">
                    {plugin.name}
                    {plugin.version && (
                      <span className="ml-1.5 text-muted-foreground">{plugin.version}</span>
                    )}
                  </span>
                  {plugin.description && (
                    <span className="block text-sm text-muted-foreground">
                      {plugin.description}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </DialogBody>
      )}
      {form.manual && (
        <Field
          label="Plugin"
          value={form.name}
          placeholder={suggestedPluginName(form.repository) || "sentry"}
          readOnly={fetching}
          onChange={(name) => set({ name })}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        {fetching ? (
          <Button type="button" variant="ghost" onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button type="button" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={fetching || (listed !== undefined && !form.name)}
        >
          {fetching ? "Fetching…" : choosing ? "Review" : "Find plugins"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Update: fetch the plugin's source again, then review the new pin (or say it's current). */
function UpdateStep(props: {
  plugin: string;
  pin: PluginPin | undefined;
  onCancel(): void;
  onPrepared(prepared: PreparedPlugin): void;
  onUpToDate(prepared: PreparedPlugin): void;
}) {
  const { mutate } = useUpdatePlugin();
  const [error, setError] = useState<string>();
  const { plugin } = props;
  const done = useEffectEvent((prepared: PreparedPlugin) => {
    if (props.pin && prepared.review.commit === props.pin.commit) props.onUpToDate(prepared);
    else props.onPrepared(prepared);
  });
  useEffect(() => {
    const controller = new AbortController();
    mutate(
      { plugin, signal: controller.signal },
      {
        onSuccess: (prepared) => controller.signal.aborted || done(prepared),
        onError: (reason) => {
          if (!controller.signal.aborted)
            setError(failure(reason, "The daemon couldn't fetch the plugin again."));
        },
      },
    );
    return () => controller.abort();
  }, [mutate, plugin]);
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Update {plugin}</DialogTitle>
        <DialogDescription>
          ace fetches its repository again and shows you what changed hands before anything is
          installed.
        </DialogDescription>
      </DialogHeader>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-ui text-muted-foreground" role="status">
          <Spinner className="size-3.5" />
          Fetching…
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={props.onCancel}>
          {error ? "Close" : "Stop"}
        </Button>
      </DialogFooter>
    </div>
  );
}
