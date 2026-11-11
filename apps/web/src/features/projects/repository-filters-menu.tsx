import { DotsThreeIcon } from "@phosphor-icons/react";
import type { RepositoryListInput, SourceControlReadiness } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Select } from "@/components/ui/select.tsx";
import type { RepositoryFilters } from "./repository-filters.ts";

/** The GitHub list's other filters, behind ⋯: host, account, owner, visibility, archives, forks. */
export function RepositoryFiltersMenu(props: {
  readiness: SourceControlReadiness | undefined;
  host: string;
  account: string;
  onAccount(choice: { host: string; account: string }): void;
  filters: RepositoryFilters;
  onFilters(filters: RepositoryFilters): void;
  rescanning: boolean;
  onRescan(): void;
}) {
  const { readiness, host, filters } = props;
  const set = (patch: Partial<RepositoryFilters>) => props.onFilters({ ...filters, ...patch });
  return (
    <Popover>
      <PopoverTrigger
        render={<IconButton icon={DotsThreeIcon} label="Repository filters" size="sm" />}
      />
      <PopoverContent align="end" aria-label="Repository filters" className="grid w-72 gap-2 p-3">
        {readiness && (
          <Select
            label="GitHub host"
            value={host}
            options={readiness.preferences.hosts.map((entry) => ({
              value: entry.host,
              label: entry.host,
            }))}
            onValueChange={(value) =>
              props.onAccount({
                host: value,
                account:
                  readiness.preferences.hosts.find((entry) => entry.host === value)?.account ?? "",
              })
            }
          />
        )}
        <Input
          aria-label="GitHub account"
          value={props.account}
          placeholder="CLI account"
          onChange={(event) => props.onAccount({ host, account: event.target.value })}
        />
        <Input
          aria-label="Repository owner"
          value={filters.owner}
          placeholder="Owner (all)"
          onChange={(event) => set({ owner: event.target.value })}
        />
        <Select<RepositoryListInput["visibility"]>
          label="Repository visibility"
          value={filters.visibility}
          options={[
            { value: "all", label: "All visibility" },
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ]}
          onValueChange={(visibility) => set({ visibility })}
        />
        <Select<RepositoryListInput["archived"]>
          label="Archived repositories"
          value={filters.archived}
          options={[
            { value: "all", label: "All archive states" },
            { value: "no", label: "Active" },
            { value: "yes", label: "Archived" },
          ]}
          onValueChange={(archived) => set({ archived })}
        />
        <Select<RepositoryListInput["fork"]>
          label="Fork repositories"
          value={filters.fork}
          options={[
            { value: "all", label: "Include forks" },
            { value: "no", label: "Exclude forks" },
            { value: "yes", label: "Forks only" },
          ]}
          onValueChange={(fork) => set({ fork })}
        />
        <Button variant="secondary" disabled={props.rescanning} onClick={props.onRescan}>
          Rescan
        </Button>
      </PopoverContent>
    </Popover>
  );
}
