import { describe, expect, test } from "vitest";
import {
  assertPublicationText,
  publicationYamlName,
  sensitivePublicationPath,
} from "./publication-sensitive.ts";
import { assertPublicationYaml } from "./publication-yaml.ts";
import { GitError } from "./types.ts";

// The publication scan applies these checks to every tracked path and every reachable blob,
// current or deleted. The end-to-end wiring (current tree, deleted history, renames, reused
// remote objects) is covered once per feature in apps/daemon's publication process tests.
function classify(path: string, content: string | Buffer): string {
  try {
    if (sensitivePublicationPath(path)) return "sensitive_publication";
    const bytes = Buffer.from(content);
    assertPublicationText(bytes);
    if (publicationYamlName(path)) assertPublicationYaml(bytes);
    return "publishable";
  } catch (error) {
    if (error instanceof GitError) return error.code;
    throw error;
  }
}

type Sample = { label: string; path: string; text: string | Buffer };

describe("credential assignments", () => {
  const blocked: Sample[] = [
    {
      label: "prefixed environment password",
      path: "config/runtime.conf",
      text: "DB_PASSWORD=opaque-value\n",
    },
    {
      label: "quoted TOML token",
      path: "config/settings.toml",
      text: '[credentials]\n"token" = "opaque-value"\n',
    },
    {
      label: "suffixed password key",
      path: "config/runtime.conf",
      text: "DB_PASSWORD_CURRENT=opaque-value\n",
    },
    {
      label: "single-quoted TOML token",
      path: "config/settings.toml",
      text: "[credentials]\n'APP_TOKEN' = 'opaque-value'\n",
    },
    {
      label: "dotted escaped TOML private key",
      path: "config/settings.toml",
      text: 'service."private\\u005fkey" = "opaque-value"\n',
    },
    {
      label: "registry-scoped npm auth",
      path: "config/runtime.conf",
      text: "//registry.example.invalid/:_auth=opaque-value\n",
    },
    { label: "API token", path: "config/runtime.conf", text: "api_token=opaque-value\n" },
    { label: "opaque auth", path: "config/runtime.conf", text: "auth=opaque-value\n" },
    {
      label: "opaque private key",
      path: "config/runtime.conf",
      text: "private_key=opaque-value\n",
    },
    {
      label: "password following an unfinished endpoint value",
      path: "config/runtime.conf",
      text: 'token_url = "unfinished\nDB_PASSWORD=opaque-value\n',
    },
    {
      label: "secret-suffixed endpoint name",
      path: "config/settings.json",
      text: '{"api_token_url_secret":"opaque-value"}\n',
    },
    {
      label: "literal token in an exempt endpoint value",
      path: "config/settings.json",
      text: JSON.stringify({ token_url: "github_pat_" + "a".repeat(32) }) + "\n",
    },
    {
      label: "literal token in an empty field's name",
      path: "config/settings.json",
      text: JSON.stringify({ ["ghp_" + "a".repeat(32)]: "" }) + "\n",
    },
    {
      label: "private-key block in an exempt policy field",
      path: "config/settings.json",
      text:
        JSON.stringify({
          token_file: "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
        }) + "\n",
    },
    {
      label: "credential-bearing URI outside assignments",
      path: "config/runtime.conf",
      text: "https://octo:opaque-value@example.invalid\n",
    },
    {
      label: "credential after an empty placeholder",
      path: "config/runtime.conf",
      text: 'DB_PASSWORD=""\napi_token=opaque-value\n',
    },
    {
      label: "value concatenated onto an empty quote",
      path: "config/runtime.conf",
      text: 'DB_PASSWORD=""opaque-value\n',
    },
  ];
  for (const sample of blocked)
    test(`blocks ${sample.label}`, () => {
      expect(classify(sample.path, sample.text)).toBe("sensitive_publication");
    });

  const ordinary: Sample[] = [
    {
      label: "ordinary environment settings",
      path: "config/runtime.conf",
      text: "DB_HOST=example.invalid\nRETRY_COUNT=3\n",
    },
    {
      label: "ordinary quoted TOML settings",
      path: "config/settings.toml",
      text: '[settings]\n"host" = "example.invalid"\n',
    },
    {
      label: "password policy and token endpoint settings",
      path: "config/runtime.conf",
      text: 'password_min_length = 8\ntoken_url = "https://example.invalid"\n',
    },
    {
      label: "credential location and lifetime settings",
      path: "config/runtime.conf",
      text: 'api_token_endpoint = "https://example.invalid"\nprivate_key_path = "local/key"\npassword_file = "local/pass"\ntoken_expiry = 120\ntoken_ttl = 60\npassword_max_length = 100\npasswordMinLength = 8\n',
    },
    {
      label: "quoted and dotted TOML policy settings",
      path: "config/settings.toml",
      text: '[settings]\n"password_min_length" = 8\n"token_url" = "https://example.invalid"\nauth.token_endpoint = "https://example.invalid"\n',
    },
    {
      label: "many short unfinished dotted expressions",
      path: "config/runtime.conf",
      text: "a . a\n".repeat(10000),
    },
    {
      label: "long non-credential scalar values",
      path: "config/runtime.conf",
      text: 'banner = "' + "a".repeat(20000) + '"\nexample = ' + "a".repeat(20000) + "\n",
    },
    {
      label: "JSON endpoint settings",
      path: "config/settings.json",
      text: '{"token_url":"https://example.invalid"}\n',
    },
    {
      label: "quoted YAML endpoint settings",
      path: "config/settings.yaml",
      text: '"token_url": "https://example.invalid"\n',
    },
    {
      label: "empty double- and single-quoted environment placeholders",
      path: "config/runtime.conf",
      text: "DB_PASSWORD=\"\"\nAPI_TOKEN=''\n",
    },
    {
      label: "empty quoted TOML placeholders",
      path: "config/settings.toml",
      text: '[settings]\n"token" = ""\n\'password\' = \'\'\n"tok\\u0065n" = ""\n',
    },
    {
      label: "empty JSON password placeholder",
      path: "config/settings.json",
      text: '{"password":""}\n',
    },
    {
      label: "empty quoted YAML placeholders",
      path: "config/settings.yaml",
      text: "\"password\": \"\"\n'token': ''\n",
    },
  ];
  for (const sample of ordinary)
    test(`accepts ${sample.label}`, () => {
      expect(classify(sample.path, sample.text)).toBe("publishable");
    });

  for (const sample of [
    { label: "long unfinished dotted key", text: "a . ".repeat(50000) },
    { label: "oversized bare key without a separator", text: "a".repeat(16385) },
    { label: "oversized quoted key without a separator", text: '"' + "a".repeat(16385) },
  ])
    test(`stops at the scan budget for a ${sample.label}`, () => {
      expect(classify("config/runtime.conf", sample.text)).toBe("publication_scan_incomplete");
    });
});

describe("YAML credentials", () => {
  const config = (user: string) =>
    `apiVersion: v1\nkind: Config\nusers:\n- name: fixture\n  user:\n${user}\n`;
  const blocked: Sample[] = [
    {
      label: "quoted Docker registry auth",
      path: "deploy/settings.yaml",
      text: "auths:\n  registry.example.invalid:\n    'auth': c3ludGhldGljOmNyZWRlbnRpYWw=\n",
    },
    {
      label: "quoted private key",
      path: "deploy/settings.yaml",
      text: "'private_key': 'opaque-value'\n",
    },
    {
      label: "single-quoted token in kubeconfig",
      path: "deploy/kubeconfig.yaml",
      text: config("    'token': opaque-value"),
    },
    {
      label: "single-quoted token in renamed kubeconfig",
      path: "deploy/KUBECONFIG.production.yml",
      text: config("    'token': opaque-value"),
    },
    {
      label: "single-quoted token",
      path: "deploy/cluster.yaml",
      text: config("    'token': opaque-value"),
    },
    {
      label: "double-quoted token",
      path: "deploy/cluster.yaml",
      text: config('    "token": opaque-value'),
    },
    {
      label: "unquoted token",
      path: "deploy/cluster.yaml",
      text: config("    token: opaque-value"),
    },
    {
      label: "escaped token key",
      path: "deploy/cluster.yaml",
      text: config('    "t\\u006fken": opaque-value'),
    },
    {
      label: "client key data",
      path: "deploy/cluster.yaml",
      text: config("    'client-key-data': b3BhcXVlLXZhbHVl"),
    },
    {
      label: "client certificate data",
      path: "deploy/cluster.yaml",
      text: config("    'client-certificate-data': b3BhcXVlLXZhbHVl"),
    },
    {
      label: "quoted password",
      path: "deploy/cluster.yaml",
      text: config("    'password': opaque-value"),
    },
    {
      label: "auth-provider configuration",
      path: "deploy/cluster.yaml",
      text: config(
        "    'auth-provider':\n      name: opaque-provider\n      config:\n        cached: opaque-value",
      ),
    },
    {
      label: "exec environment",
      path: "deploy/cluster.yaml",
      text: config(
        "    'exec':\n      command: credential-helper\n      'env':\n      - name: OPAQUE_AUTH\n        value: opaque-value",
      ),
    },
  ];
  for (const sample of blocked)
    test(`blocks ${sample.path} with ${sample.label}`, () => {
      expect(classify(sample.path, sample.text)).toBe("sensitive_publication");
    });

  for (const sample of [
    { name: "malformed YAML", text: "settings: [broken" },
    { name: "an alias", text: "base: &base {value: safe}\ncopy: *base\n" },
    { name: "an unknown tag", text: "value: !opaque safe\n" },
    { name: "excessive size", text: "#" + "a".repeat(1024 * 1024) },
    {
      name: "excessive depth",
      text: Array.from({ length: 66 }, (_, index) => "  ".repeat(index) + "value:\n").join(""),
    },
    { name: "excessive nodes", text: "values:\n" + "- safe\n".repeat(100001) },
    { name: "excessive documents", text: "---\nvalue: safe\n".repeat(21) },
  ])
    test(`fails closed for ${sample.name}`, () => {
      expect(classify("deploy/settings.yaml", sample.text)).toBe("publication_scan_incomplete");
    });

  test("accepts inspectable YAML without credential fields", () => {
    expect(
      classify("deploy/settings.yaml", "apiVersion: v1\nkind: Config\ncontexts: []\nusers: []\n"),
    ).toBe("publishable");
  });

  test("structural YAML limits apply to every YAML spelling and only to YAML names", () => {
    expect(classify("deploy/settings.YML", "settings: [broken")).toBe(
      "publication_scan_incomplete",
    );
    expect(classify("deploy/settings.txt", "settings: [broken")).toBe("publishable");
  });
});

describe("sensitive paths and literal secrets", () => {
  const blocked: Sample[] = [
    { label: "dotenv variant", path: ".env.production", text: "setting=value" },
    { label: "credentials file", path: "config/credentials.json", text: "{}" },
    {
      label: "OpenSSH private key block",
      path: "notes.txt",
      text: "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----",
    },
    { label: "GitHub token", path: "src/config.txt", text: "ghp_" + "x".repeat(32) },
    {
      label: "bearer value in binary content",
      path: "archive.bin",
      text: "\0Bearer synthetic-private-value\0",
    },
    {
      label: "credential in a URL fragment",
      path: "docs/link.txt",
      text: "https://example.invalid/#ticket=opaque-credential",
    },
    {
      label: "Docker config",
      path: ".docker/config.json",
      text: JSON.stringify({
        auths: { "registry.example.invalid": { auth: "c3ludGhldGljOmNyZWRlbnRpYWw=" } },
      }),
    },
    {
      label: "escaped Docker auth field",
      path: "registry.json",
      text: '{"auths":{"registry.example.invalid":{"a\\u0075th":"c3ludGhldGljOmNyZWRlbnRpYWw="}}}',
    },
    { label: "npmrc", path: ".npmrc", text: "//registry.example.invalid/:_authToken=synthetic" },
    {
      label: "copied npm auth token",
      path: "copied-config.txt",
      text: "//registry.example.invalid/:_authToken=synthetic",
    },
    { label: "pypirc", path: ".pypirc", text: "[index-server]\npassword = synthetic" },
    {
      label: "netrc",
      path: ".netrc",
      text: "machine example.invalid login synthetic password synthetic",
    },
    {
      label: "git credentials",
      path: ".git-credentials",
      text: "https://synthetic:synthetic@example.invalid",
    },
    {
      label: "AWS credentials",
      path: ".aws/credentials",
      text: "[default]\naws_secret_access_key=synthetic",
    },
    { label: "Azure token cache", path: ".azure/msal_token_cache.bin", text: "synthetic" },
    { label: "gcloud token store", path: ".config/gcloud/access_tokens.db", text: "synthetic" },
    {
      label: "copied AWS access key id",
      path: "copied-cloud.json",
      text: JSON.stringify({ profile: { aws_access_key_id: "synthetic" } }),
    },
  ];
  for (const sample of blocked)
    test(`blocks ${sample.path} (${sample.label})`, () => {
      expect(classify(sample.path, sample.text)).toBe("sensitive_publication");
    });

  test("Git LFS pointers cannot be inspected and fail closed", () => {
    expect(
      classify("asset.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n"),
    ).toBe("publication_scan_incomplete");
  });
});
