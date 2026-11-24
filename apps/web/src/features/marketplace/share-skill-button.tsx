import type { ClientApi } from "@ace/client";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import { useState } from "react";
import { LinkSimpleIcon } from "@ace/icons";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.tsx";
import { marketShareUrl } from "./market-address.ts";
import { market } from "./market-api.ts";
import { usePersonGrant } from "./market-publishing.ts";

type Review = Extract<MarketResult, { op: "skillShareReview" }>;

export function ShareSkillButton({
  client,
  source,
  name,
  title,
}: {
  client: ClientApi;
  source: Extract<MarketOperation, { op: "shareSkill" }>["source"];
  name: string;
  title?: string | undefined;
}) {
  const grant = usePersonGrant();
  const [version, setVersion] = useState("1.0.0");
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<Review>();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [link, setLink] = useState<string>();

  async function load() {
    setOpen(true);
    setReview(undefined);
    setChecked(new Set());
    setLink(undefined);
    setProblem(undefined);
    setPending(true);
    try {
      setReview(await market(client, { op: "shareSkill", source }, "skillShareReview"));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't review the skill.");
    } finally {
      setPending(false);
    }
  }

  async function publish(review: Review) {
    if (pending || !review.files.every(({ path }) => checked.has(path))) return;
    setPending(true);
    setProblem(undefined);
    try {
      const { id } = await market(
        client,
        {
          op: "shareSkill",
          source,
          version,
          reviewed: review.hash,
          acknowledged: review.files.map((file) => file.digest),
        },
        "skillShared",
        undefined,
        grant,
      );
      setLink(marketShareUrl(id));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't share the skill.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <IconButton
        icon={LinkSimpleIcon}
        size="panel"
        label={`Share ${name}`}
        disabled={pending}
        onClick={() => void load()}
      />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full max-w-full gap-0 sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Share {title ?? name}</SheetTitle>
            <SheetDescription>
              Anyone with the link can install after Store review.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-4 overflow-auto px-4 pb-4">
            {review && !link && (
              <label className="flex flex-col gap-2">
                Version
                <input
                  className="rounded-md border border-border px-2 py-1"
                  value={version}
                  disabled={pending}
                  onChange={(event) => setVersion(event.currentTarget.value)}
                />
              </label>
            )}
            {problem && <p role="alert">{problem}</p>}
            {pending && !review && <p role="status">Checking skill…</p>}
            {link ? (
              <a className="break-all underline" href={link}>
                {link}
              </a>
            ) : (
              review?.files.map(({ path, text, executable }) => (
                <div key={path} className="flex flex-col gap-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked.has(path)}
                      disabled={pending}
                      onChange={(event) => {
                        const next = new Set(checked);
                        if (event.currentTarget.checked) next.add(path);
                        else next.delete(path);
                        setChecked(next);
                      }}
                    />
                    Reviewed {path}
                    {executable ? " (executable)" : ""}
                  </label>
                  <pre className="whitespace-pre-wrap break-words text-xs">{text}</pre>
                </div>
              ))
            )}
          </div>
          <SheetFooter>
            {link ? (
              <Button onClick={() => void navigator.clipboard.writeText(link)}>Copy link</Button>
            ) : review ? (
              <Button
                disabled={pending || checked.size !== review.files.length}
                onClick={() => void publish(review)}
              >
                {pending ? "Sharing…" : "Publish unlisted"}
              </Button>
            ) : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
