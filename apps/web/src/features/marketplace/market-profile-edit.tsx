import type { MarketLink, MarketProfile } from "@ace/protocol/marketplace";
import { MarketHandle, MarketLink as LinkSchema } from "@ace/protocol/marketplace";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { failureSentence } from "./market-model.ts";
import { Avatar } from "./market-marks.tsx";
import { useMarketPicture, usePublishAction } from "./market-publishing.ts";
import { part } from "@/lib/suit-part.ts";

/*
 * Making and editing your publisher profile (ADR 0174 §3): a handle and a name to start, then
 * the name, bio, links and picture. Each save is one publish action; what it can't take is said
 * in a sentence under the form.
 */

const bioLimit = 500;

/** The file's bytes as base64, for `setAvatar`. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

function Problem(props: { text: string | undefined }) {
  return props.text ? (
    <p role="alert" className="mk-withdrawn-line">
      {props.text}
    </p>
  ) : null;
}

export function MakeProfile() {
  const action = usePublishAction();
  const [handle, setHandle] = useState("");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string>();
  const make = () => {
    if (!MarketHandle.safeParse(handle).success) {
      setProblem("A handle is 3 to 32 lowercase letters, digits and single dashes.");
      return;
    }
    setProblem(undefined);
    action.mutate(
      {
        action: "createProfile",
        profile: { handle, displayName: name.trim(), bio: "", links: [] },
      },
      { onError: (error) => setProblem(failureSentence(error, "change")) },
    );
  };
  return (
    <div className="mk-form" style={{ maxWidth: 480, marginTop: 8 }}>
      <h1 {...part("page-title", undefined, "market")} className="mk-display-sm">
        Make your publisher profile
      </h1>
      <p className="mk-lead" style={{ fontSize: 15 }}>
        People see it on everything you publish.
      </p>
      <div>
        <label className="mk-label" htmlFor="mk-me-handle">
          Handle
        </label>
        <input
          id="mk-me-handle"
          className="mk-field"
          value={handle}
          autoComplete="off"
          onChange={(event) => setHandle(event.target.value.toLowerCase())}
        />
      </div>
      <div>
        <label className="mk-label" htmlFor="mk-me-name">
          Name
        </label>
        <input
          id="mk-me-name"
          className="mk-field"
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <Problem text={problem} />
      <div>
        <Button
          variant="primary"
          size="lg"
          disabled={!handle || !name.trim() || action.isPending}
          onClick={make}
        >
          Make profile
        </Button>
      </div>
    </div>
  );
}

export function ProfileEditor(props: { profile: MarketProfile; onDone(): void }) {
  const { profile } = props;
  const action = usePublishAction();
  const picture = useMarketPicture("avatar", profile.avatar);
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio);
  // Each row keeps its own id, so typing in one never moves another's focus.
  const ids = useRef(profile.links.length);
  const [links, setLinks] = useState<(MarketLink & { id: number })[]>(
    profile.links.map((link, at) => ({ ...link, id: at })),
  );
  const [problem, setProblem] = useState<string>();
  const setLink = (at: number, patch: Partial<MarketLink>) =>
    setLinks((before) =>
      before.map((link, index) => (index === at ? { ...link, ...patch } : link)),
    );
  const save = () => {
    const kept = links
      .filter((link) => link.label.trim() || link.url.trim())
      .map((link) => ({ label: link.label, url: link.url }));
    if (kept.some((link) => !LinkSchema.safeParse(link).success)) {
      setProblem("Each link needs a short label and an https address.");
      return;
    }
    setProblem(undefined);
    action.mutate(
      { action: "editProfile", profile: { displayName: name.trim(), bio, links: kept } },
      {
        onSuccess: props.onDone,
        onError: (error) => setProblem(failureSentence(error, "change")),
      },
    );
  };
  const choosePicture = async (chosen: File | undefined) => {
    if (!chosen) return;
    action.mutate(
      { action: "setAvatar", image: await base64Of(chosen) },
      { onError: (error) => setProblem(failureSentence(error, "change")) },
    );
  };
  return (
    <div className="mk-profile-head">
      <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
        <Avatar name={name || profile.displayName} size={96} picture={picture} />
        <button
          type="button"
          {...part("link")}
          className="mk-quiet"
          onClick={() => file.current?.click()}
        >
          Change picture
        </button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-label="Picture"
          onChange={(event) => void choosePicture(event.target.files?.[0])}
        />
      </div>
      <div className="mk-profile-words mk-form" style={{ gap: 16 }}>
        <input
          className="mk-field"
          data-big=""
          aria-label="Name"
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        <span className="mk-meta">@{profile.handle}</span>
        <div>
          <label className="mk-label" htmlFor="mk-me-bio">
            Bio{" "}
            <span className="mk-hint-count">
              {bio.length}/{bioLimit}
            </span>
          </label>
          <textarea
            id="mk-me-bio"
            className="mk-field"
            rows={2}
            maxLength={bioLimit}
            value={bio}
            onChange={(event) => setBio(event.target.value)}
          />
        </div>
        <div>
          <span className="mk-label">Links</span>
          <div style={{ display: "grid", gap: 8 }}>
            {links.map((link, at) => (
              <div
                key={link.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "140px minmax(0, 1fr) auto",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <input
                  className="mk-field"
                  aria-label={`Link ${at + 1} label`}
                  placeholder="Label"
                  maxLength={40}
                  value={link.label}
                  onChange={(event) => setLink(at, { label: event.target.value })}
                />
                <input
                  className="mk-field"
                  aria-label={`Link ${at + 1} address`}
                  placeholder="https://"
                  value={link.url}
                  onChange={(event) => setLink(at, { url: event.target.value })}
                />
                <button
                  type="button"
                  {...part("link")}
                  className="mk-quiet"
                  style={{ margin: 0 }}
                  aria-label={`Remove link ${at + 1}`}
                  onClick={() => setLinks((before) => before.filter((_, index) => index !== at))}
                >
                  Remove
                </button>
              </div>
            ))}
            {links.length < 5 && (
              <button
                type="button"
                {...part("link")}
                className="mk-quiet"
                style={{ justifySelf: "start" }}
                onClick={() =>
                  setLinks((before) => [...before, { label: "", url: "", id: ids.current++ }])
                }
              >
                Add a link
              </button>
            )}
          </div>
        </div>
        <Problem text={problem} />
      </div>
      <div className="mk-profile-actions">
        <Button variant="ghost" size="lg" onClick={props.onDone}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={!name.trim() || action.isPending}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
