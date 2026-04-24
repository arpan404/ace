import { describe, expect, it } from "vitest";

import {
  MONACO_DOTENV_LANGUAGE_ID,
  MONACO_PRISMA_LANGUAGE_ID,
  resolveMonacoLanguageFromFilePath,
} from "./workspaceLanguageMapping";

describe("resolveMonacoLanguageFromFilePath", () => {
  it("maps Prisma schemas to the custom Prisma language", () => {
    expect(resolveMonacoLanguageFromFilePath("apps/server/prisma/schema.prisma")).toBe(
      MONACO_PRISMA_LANGUAGE_ID,
    );
  });

  it("maps dotenv files to the custom dotenv language", () => {
    expect(resolveMonacoLanguageFromFilePath(".env")).toBe(MONACO_DOTENV_LANGUAGE_ID);
    expect(resolveMonacoLanguageFromFilePath("apps/web/.env.local")).toBe(
      MONACO_DOTENV_LANGUAGE_ID,
    );
  });

  it("maps common infrastructure files to Monaco languages with tokenizers", () => {
    expect(resolveMonacoLanguageFromFilePath("Dockerfile")).toBe("dockerfile");
    expect(resolveMonacoLanguageFromFilePath("docker/Dockerfile.dev")).toBe("dockerfile");
    expect(resolveMonacoLanguageFromFilePath("deploy/compose.yaml")).toBe("yaml");
    expect(resolveMonacoLanguageFromFilePath("schema/query.graphql")).toBe("graphql");
    expect(resolveMonacoLanguageFromFilePath(".zshrc")).toBe("shell");
    expect(resolveMonacoLanguageFromFilePath("db/migration.sql")).toBe("sql");
  });

  it("maps common app languages to Monaco tokenizers", () => {
    expect(resolveMonacoLanguageFromFilePath("src/main.rs")).toBe("rust");
    expect(resolveMonacoLanguageFromFilePath("cmd/server.go")).toBe("go");
    expect(resolveMonacoLanguageFromFilePath("app/models/user.py")).toBe("python");
    expect(resolveMonacoLanguageFromFilePath("lib/tasks/build.rake")).toBe("ruby");
    expect(resolveMonacoLanguageFromFilePath("src/App.swift")).toBe("swift");
    expect(resolveMonacoLanguageFromFilePath("src/main.kt")).toBe("kotlin");
    expect(resolveMonacoLanguageFromFilePath("src/index.cpp")).toBe("cpp");
    expect(resolveMonacoLanguageFromFilePath("src/Program.cs")).toBe("csharp");
    expect(resolveMonacoLanguageFromFilePath("contracts/Token.sol")).toBe("solidity");
  });

  it("maps common basename-driven files to better defaults", () => {
    expect(resolveMonacoLanguageFromFilePath("Gemfile")).toBe("ruby");
    expect(resolveMonacoLanguageFromFilePath("ios/Podfile")).toBe("ruby");
    expect(resolveMonacoLanguageFromFilePath("CMakeLists.txt")).toBe("cpp");
  });

  it("returns undefined for unknown file types", () => {
    expect(resolveMonacoLanguageFromFilePath("README.unknown-language")).toBeUndefined();
  });
});
