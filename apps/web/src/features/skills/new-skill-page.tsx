import type { ProviderKind } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Screen } from "@/features/shell/index.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import { skillAgents } from "./library-model.ts";
import { SkillRequestError, useCreateSkill } from "./library-source.ts";
import { NewSkillForm, type NewSkill } from "./new-skill-form.tsx";
import { SkillPageSkeleton } from "./skills-landing-screen.tsx";
import { useSkillLibrary } from "./skills-library.tsx";

/** Where the daemon saves a new skill (ADR 0103), as the form previews it. */
const pathFor = (scope: NewSkill["scope"], name: string) =>
  `${scope === "personal" ? "~/" : ""}.agents/skills/${name}/SKILL.md`;

/** Write a new skill; once the library lists it, its page opens. */
export function NewSkillPage() {
  const statuses = useProviderStatuses();
  const library = useSkillLibrary();
  const navigate = useNavigate();
  const create = useCreateSkill();
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<string>();
  const listed = !!created && !!library.entries?.some((entry) => entry.id === created);
  useEffect(() => {
    if (listed && created)
      void navigate({ to: "/skills/$skillId", params: { skillId: created }, replace: true });
  }, [listed, created, navigate]);
  // Agents start ticked when they are installed on the daemon's machine.
  const installed = statuses.data
    ? skillAgents.filter((agent) =>
        statuses.data?.some((status) => status.provider === agent && status.state !== "not_installed"),
      )
    : statuses.isError
      ? skillAgents
      : undefined;
  const names = new Set(library.entries?.map((entry) => entry.name));
  return (
    <Screen title="Skills">
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-(--column) px-4 pt-6 pb-20 sm:px-8 sm:pt-11">
          <h2 className="text-2xl font-semibold tracking-title">New skill</h2>
          {!installed ? (
            <SkillPageSkeleton />
          ) : (
            <NewSkillForm
              project={library.project?.name}
              agents={skillAgents}
              initialAgents={installed.length ? installed : skillAgents}
              taken={(name) => names.has(name)}
              pathFor={pathFor}
              creating={create.isPending || !!created}
              error={error}
              onCancel={() => void navigate({ to: "/skills" })}
              onCreate={(skill) => {
                setError(undefined);
                const project = library.project;
                create.mutate(
                  {
                    name: skill.name,
                    description: skill.description,
                    body: skill.instructions,
                    scope:
                      skill.scope === "project" && project
                        ? { kind: "project", workspaceId: project.id }
                        : { kind: "personal" },
                    agents: skill.providers.filter(isSkillAgent),
                    manual: skill.manual,
                  },
                  {
                    onSuccess: (entry) => setCreated(entry.id),
                    onError: (failure) =>
                      setError(
                        failure instanceof SkillRequestError
                          ? `Couldn't create the skill. ${failure.message}`
                          : "Couldn't create the skill. Check your connection and try again.",
                      ),
                  },
                );
              }}
            />
          )}
        </div>
      </div>
    </Screen>
  );
}

const isSkillAgent = (provider: ProviderKind) => skillAgents.includes(provider);
