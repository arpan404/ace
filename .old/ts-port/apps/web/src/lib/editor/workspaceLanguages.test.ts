import { describe, expect, it } from "vitest";

import {
  WORKSPACE_DOTENV_LANGUAGE_ID,
  WORKSPACE_PRISMA_LANGUAGE_ID,
  resolveWorkspaceLanguageFromFilePath,
} from "./workspaceLanguageMapping";

describe("resolveWorkspaceLanguageFromFilePath", () => {
  it("maps Prisma schemas to the custom Prisma language", () => {
    expect(resolveWorkspaceLanguageFromFilePath("apps/server/prisma/schema.prisma")).toBe(
      WORKSPACE_PRISMA_LANGUAGE_ID,
    );
  });

  it("maps dotenv files to the custom dotenv language", () => {
    expect(resolveWorkspaceLanguageFromFilePath(".env")).toBe(WORKSPACE_DOTENV_LANGUAGE_ID);
    expect(resolveWorkspaceLanguageFromFilePath("apps/web/.env.local")).toBe(
      WORKSPACE_DOTENV_LANGUAGE_ID,
    );
  });

  it("maps common infrastructure files to workspace language ids", () => {
    expect(resolveWorkspaceLanguageFromFilePath("Dockerfile")).toBe("dockerfile");
    expect(resolveWorkspaceLanguageFromFilePath("docker/Dockerfile.dev")).toBe("dockerfile");
    expect(resolveWorkspaceLanguageFromFilePath("deploy/compose.yaml")).toBe("yaml");
    expect(resolveWorkspaceLanguageFromFilePath("schema/query.graphql")).toBe("graphql");
    expect(resolveWorkspaceLanguageFromFilePath(".zshrc")).toBe("shell");
    expect(resolveWorkspaceLanguageFromFilePath("db/migration.sql")).toBe("sql");
  });

  it("maps common app languages to workspace language ids", () => {
    expect(resolveWorkspaceLanguageFromFilePath("src/main.rs")).toBe("rust");
    expect(resolveWorkspaceLanguageFromFilePath("cmd/server.go")).toBe("go");
    expect(resolveWorkspaceLanguageFromFilePath("app/models/user.py")).toBe("python");
    expect(resolveWorkspaceLanguageFromFilePath("lib/tasks/build.rake")).toBe("ruby");
    expect(resolveWorkspaceLanguageFromFilePath("src/App.swift")).toBe("swift");
    expect(resolveWorkspaceLanguageFromFilePath("src/main.kt")).toBe("kotlin");
    expect(resolveWorkspaceLanguageFromFilePath("src/index.cpp")).toBe("cpp");
    expect(resolveWorkspaceLanguageFromFilePath("src/Program.cs")).toBe("csharp");
    expect(resolveWorkspaceLanguageFromFilePath("contracts/Token.sol")).toBe("solidity");
  });

  it("maps common basename-driven files to better defaults", () => {
    expect(resolveWorkspaceLanguageFromFilePath("Gemfile")).toBe("ruby");
    expect(resolveWorkspaceLanguageFromFilePath("ios/Podfile")).toBe("ruby");
    expect(resolveWorkspaceLanguageFromFilePath("CMakeLists.txt")).toBe("cpp");
  });

  it("returns undefined for unknown file types", () => {
    expect(resolveWorkspaceLanguageFromFilePath("README.unknown-language")).toBeUndefined();
  });
});
