import { mergeSpadeModels } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { botBubble } from "./spade-card.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { spadeModelLabel } from "./spade-model-options.ts";
import { useEditBot } from "./spade-profile-actions.ts";
import type { RosterBot } from "./use-spade-roster.ts";
import { useSpadeModels } from "./use-spade-models.ts";

/**
 * A bot whose subscription's maker no longer allows this (ADR 0205 §4), once, at the end of its
 * chat: Spade's words, the person's own models as one-tap choices (its route first), and any
 * other model. Nothing is switched for them: what they send waits until they pick.
 */
export function SpadeTermsHold(props: { bot: RosterBot }) {
  const hold = props.bot.termsHold;
  const edit = useEditBot(props.bot);
  const models = useSpadeModels(true);
  const [refusal, setRefusal] = useState<string>();
  const [picking, setPicking] = useState<string>();
  if (!hold) return null;
  const sources = {
    endpoints: (models.data?.endpoints ?? []).map((endpoint) => ({
      endpoint,
      models: mergeSpadeModels(endpoint.models, undefined),
    })),
    subscriptions: [],
  };
  const pick = async (model: string) => {
    if (!model) return;
    setPicking(model);
    setRefusal(await edit({ model }));
    setPicking(undefined);
  };
  return (
    <div
      role="group"
      aria-label={`${props.bot.name} waits for another model`}
      className={cn(botBubble, "flex flex-col gap-2")}
    >
      <p>{hold.text}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {hold.choices.map((model) => {
          const shown = spadeModelLabel(sources, model);
          return (
            <Button
              key={model}
              size="sm"
              variant="secondary"
              disabled={picking !== undefined}
              onClick={() => void pick(model)}
            >
              {picking === model ? "Moving…" : shown.name}
              {shown.source && (
                <span className="text-muted-foreground">{` · ${shown.source}`}</span>
              )}
            </Button>
          );
        })}
        <SpadeModelPicker
          label="Another model"
          value=""
          onChange={(model) => void pick(model)}
          className="w-auto"
        />
      </div>
      {refusal && (
        <p role="alert" className="text-ui text-destructive">
          {refusal}
        </p>
      )}
    </div>
  );
}
