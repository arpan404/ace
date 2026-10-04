/** Selection facts contain no paths or filesystem operations. */
export type HomeLayout = "empty" | "rewrite" | "unknown" | "incompatible";
export function selectDefaultHome(facts: {
  primary: HomeLayout;
  isolated: HomeLayout;
  isolatedMarker: boolean;
}): "primary" | "isolated" {
  if (facts.isolatedMarker) {
    if (facts.isolated === "incompatible") throw new Error("Incompatible isolated ace home");
    return "isolated";
  }
  if (facts.primary === "empty" || facts.primary === "rewrite") return "primary";
  if (facts.isolated === "unknown" || facts.isolated === "incompatible")
    throw new Error("Unrecognized data in isolated ace home; choose an empty ACE_HOME");
  return "isolated";
}
