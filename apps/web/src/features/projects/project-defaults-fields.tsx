import { ProviderKind, type ProjectDefaults } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import type { ReactNode } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { AccessSelect } from "@/components/access-select.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { useBaseRefs } from "@/lib/branches.ts";
import { useNewThreadOptions } from "@/features/models/index.ts";

const inherit = "inherit";
const separator = "\n";

/** The models a project can default to: each provider's model once, whatever account serves it. */
function useModelOptions(current: ProjectDefaults): SelectOption<string>[] {
  const models = useNewThreadOptions()?.models ?? [];
  const seen = new Set<string>();
  const options: SelectOption<string>[] = [{ value: inherit, label: "Inherit" }];
  const add = (provider: ProviderKind, id: string, label: string) => {
    const value = `${provider}${separator}${id}`;
    if (seen.has(value)) return;
    seen.add(value);
    options.push({
      value,
      label: `${label} · ${providerNames[provider]}`,
      icon: <ProviderIcon provider={provider} model={id} size={14} decorative />,
    });
  };
  for (const model of models) if (!model.legacy) add(model.provider, model.id, model.label);
  // A saved default the catalog doesn't list right now stays shown rather than silently lost.
  if (current.provider && current.model) add(current.provider, current.model, current.model);
  return options;
}

function useBranchOptions(projectId: string, current: string | undefined) {
  const { refs } = useBaseRefs(projectId);
  const names = [...new Set(refs.filter((ref) => !ref.remote).map((ref) => ref.name))];
  if (current && !names.includes(current)) names.unshift(current);
  return [
    { value: inherit, label: "Inherit" },
    ...names.map((name) => ({ value: name, label: name })),
  ];
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <span aria-hidden className="text-sm text-muted-foreground">
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

/** What new threads in the project start with; every field inherits until set. */
export function ProjectDefaultsFields(props: {
  projectId: string;
  value: ProjectDefaults;
  onChange(value: ProjectDefaults): void;
}) {
  const { value, onChange } = props;
  const models = useModelOptions(value);
  const branches = useBranchOptions(props.projectId, value.baseBranch);
  const model =
    value.provider && value.model ? `${value.provider}${separator}${value.model}` : inherit;
  const without = <K extends keyof ProjectDefaults>(...keys: K[]) => {
    const next = { ...value };
    for (const key of keys) delete next[key];
    return next;
  };
  return (
    <div role="group" aria-label="New threads" className="grid gap-1">
      <h3 className="text-sm font-medium text-muted-foreground">New threads</h3>
      <Row label="Model">
        <Select
          label="Default model"
          className="w-56"
          value={model}
          options={models}
          onValueChange={(picked) => {
            if (picked === inherit) return onChange(without("provider", "model"));
            const [kind, id] = picked.split(separator);
            const provider = ProviderKind.safeParse(kind);
            if (!provider.success || !id) return;
            onChange({ ...value, provider: provider.data, model: id });
          }}
        />
      </Row>
      <Row label="Access">
        <AccessSelect
          label="Default access"
          className="w-56"
          value={value.access}
          inheritLabel="Inherit"
          onChange={(access) => onChange(access ? { ...value, access } : without("access"))}
        />
      </Row>
      <Row label="Worktree">
        <SegmentedControl
          label="New threads use a worktree"
          size="sm"
          value={value.worktree === undefined ? inherit : value.worktree ? "on" : "off"}
          options={[
            { value: inherit, label: "Inherit" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          onValueChange={(picked) =>
            onChange(
              picked === inherit ? without("worktree") : { ...value, worktree: picked === "on" },
            )
          }
        />
      </Row>
      <Row label="Base branch">
        <Select
          label="Default base branch"
          className="w-56"
          value={value.baseBranch ?? inherit}
          options={branches}
          onValueChange={(picked) =>
            onChange(picked === inherit ? without("baseBranch") : { ...value, baseBranch: picked })
          }
        />
      </Row>
    </div>
  );
}
