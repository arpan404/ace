/**
 * The desktop app's own microphone permission (macOS asks for it once per app, and refuses
 * every page after a "Don't Allow"). In a browser, or on a desktop that doesn't say, the page's
 * own permission prompt is all there is: undefined, nothing to wait for.
 */
export function allowMicrophone(scope: object = globalThis): Promise<void> | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  const permissions: unknown =
    typeof ace === "object" && ace !== null ? Reflect.get(ace, "permissions") : undefined;
  const ask: unknown =
    typeof permissions === "object" && permissions !== null
      ? Reflect.get(permissions, "microphone")
      : undefined;
  if (typeof ask !== "function") return undefined;
  return Promise.resolve(Reflect.apply(ask, permissions, [])).then(
    (answer: unknown) => {
      if (answer === "denied" || answer === "restricted")
        throw new Error(
          "ace isn't allowed to use the microphone. Turn it on in System Settings › Privacy & Security › Microphone.",
        );
    },
    // The desktop couldn't say: let the page try, and fail on its own terms.
    () => {},
  );
}
