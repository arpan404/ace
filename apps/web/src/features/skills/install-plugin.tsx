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
import {
  Dialog,
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
  suggestedPluginName,
  type PluginPin,
} from "./skills-model.ts";
import {
  useCancelReview,
  usePreparePlugin,
  useUpdatePlugin,
  type PreparedPlugin,
} from "./skills-source.ts";

const failure = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

interface SourceForm {
  repository: string;
  ref: string;
  name: string;
}
const emptyForm: SourceForm = { repository: "", ref: "main", name: "" };

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
                setStep({ kind: "review", prepared, from: undefined, back: "close" })
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

/** Where the plugin comes from: the form keeps its values when a review goes Back. */
function SourceStep(props: {
  form: SourceForm;
  onChange(form: SourceForm): void;
  onCancel(): void;
  onPrepared(prepared: PreparedPlugin, from: string): void;
}) {
  const { form } = props;
  const [error, setError] = useState<string>();
  const prepare = usePreparePlugin();
  const abort = useRef<AbortController>(null);
  // Leaving the step (closing the dialog) stops a fetch still in flight.
  useEffect(() => () => abort.current?.abort(), []);
  const set = (patch: Partial<SourceForm>) => props.onChange({ ...form, ...patch });
  const submit = async () => {
    const source = PluginRepository.safeParse(form.repository);
    const pin = PluginRef.safeParse(form.ref);
    const plugin = PluginNameInput.safeParse(form.name || suggestedPluginName(form.repository));
    if (!source.success || !pin.success || !plugin.success) {
      setError((source.error ?? pin.error ?? plugin.error)?.issues[0]?.message);
      return;
    }
    setError(undefined);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const prepared = await prepare.mutateAsync({
        repository: source.data,
        ref: pin.data,
        name: plugin.data,
        signal: controller.signal,
      });
      props.onPrepared(prepared, `${form.repository.trim()} @ ${pin.data}`);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(failure(reason, "The daemon couldn't fetch that plugin."));
    }
  };
  const stop = () => {
    abort.current?.abort();
    prepare.reset();
  };
  const fetching = prepare.isPending;
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!fetching) void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Install a plugin</DialogTitle>
        <DialogDescription>
          ace fetches the repository, finds the plugin in its marketplace and shows you what it
          runs. Nothing is enabled until you accept.
        </DialogDescription>
      </DialogHeader>
      <Field
        label="Repository"
        value={form.repository}
        placeholder="getsentry/sentry-mcp"
        readOnly={fetching}
        onChange={(repository) => set({ repository })}
      />
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <Field
          label="Plugin"
          value={form.name}
          placeholder={suggestedPluginName(form.repository) || "sentry"}
          readOnly={fetching}
          onChange={(name) => set({ name })}
        />
        <Field
          label="Branch or tag"
          value={form.ref}
          placeholder="main"
          readOnly={fetching}
          onChange={(ref) => set({ ref })}
        />
      </div>
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
        <Button type="submit" variant="primary" disabled={fetching}>
          {fetching ? "Fetching…" : "Review"}
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
