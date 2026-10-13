import { expect, test } from "vitest";
import { openApiDocument, requiredRoutes, validateSpec, version } from "./contract.ts";

test("OpenCode 2.0.x patch releases from 2.0.22 pass the version gate; other lines do not", () => {
  expect(["2.0.22", "2.0.26", "2.0.27", "2.0.140"].filter(version)).toEqual([
    "2.0.22",
    "2.0.26",
    "2.0.27",
    "2.0.140",
  ]);
  expect(["2.0.21", "2.1.0", "3.0.0", "1.18.33", "2.0.27-beta", "", undefined].some(version)).toBe(
    false,
  );
});

test("2.0.27 is accepted when its contract serves every route ace calls, with extra operations and fields kept", () => {
  const spec = openApiDocument();
  // 2.0.27 adds operations, info fields and vendor extensions; none of those are fatal.
  spec.paths["/api/experimental/persistent-pty/{ptyID}"] = { get: { operationId: "pty.get" } };
  const lenient = { ...spec, info: { title: "opencode HttpApi" }, "x-effect": { stream: true } };
  expect(() => validateSpec(lenient, "2.0.27")).not.toThrow();
});

test("a contract that drops or moves an operation is refused with a reason naming each change", () => {
  const routes: Record<string, string> = { ...requiredRoutes };
  delete routes["session.prompt"];
  routes["shell.get"] = "GET /api/v3/shell/{id}";
  expect(() => validateSpec(openApiDocument(routes), "2.0.27")).toThrow(
    "OpenCode 2.0.27 changed the API ace uses (session.prompt is missing; shell.get moved from GET /api/shell/:id to GET /api/v3/shell/:id); ace supports OpenCode 2.0.x, 2.0.22 or newer with the 2.0.22 API",
  );
});
