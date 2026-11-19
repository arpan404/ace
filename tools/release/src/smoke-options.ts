import { parseArgs } from "node:util";

/** A root-only invocation keeps the original pre-signing archive smoke contract. */
export function smokeOptions(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "unsigned-archive": { type: "boolean" },
      "signed-archive": { type: "boolean" },
      manifest: { type: "string" },
      "public-key": { type: "string" },
      desktop: { type: "string" },
      "screen-identity": { type: "string" },
      local: { type: "boolean" },
      "verify-authenticode": { type: "boolean" },
    },
  });
  const root = positionals[0];
  if (!root || positionals.length !== 1)
    throw new Error(
      "Usage: smoke RELEASE_ROOT [--unsigned-archive | --signed-archive --manifest FILE --public-key FILE] [--desktop APP]",
    );
  const signed = values["signed-archive"] || values.manifest || values["public-key"];
  if (signed && values["unsigned-archive"])
    throw new Error("Signed and unsigned archive modes are mutually exclusive");
  if (signed && (!values.manifest || !values["public-key"]))
    throw new Error("Signed archive smoke needs --manifest and --public-key");
  return {
    root,
    manifestPath: values.manifest,
    keyPath: values["public-key"],
    app: values.desktop,
    snapshot: values["screen-identity"],
    production: !values.local,
    authenticode: values["verify-authenticode"] === true,
  };
}
