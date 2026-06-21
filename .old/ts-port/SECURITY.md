# Security Policy

ace runs local provider CLIs, opens local workspaces, manages a daemon, and can relay encrypted remote-control traffic. Please treat security issues in those areas as sensitive.

## Reporting A Vulnerability

Do not open a public issue for suspected vulnerabilities.

Report privately through GitHub Security Advisories for this repository:

https://github.com/arpan404/ace/security/advisories/new

Include:

- Affected version, commit, or branch.
- Operating system and install method.
- Steps to reproduce.
- Impact and required attacker access.
- Logs, screenshots, or proof-of-concept details with secrets redacted.

## Scope

In scope:

- Local daemon authentication or origin bypasses.
- Workspace file access outside intended paths.
- Provider CLI command injection or unsafe argument handling.
- Desktop updater, signing, or install flow vulnerabilities.
- Remote relay pairing, routing, or encryption failures.
- Secret leakage in logs, telemetry, or crash output.

Out of scope:

- Vulnerabilities in upstream provider CLIs unless ace makes them exploitable in a new way.
- Social engineering.
- Denial of service requiring local shell access without privilege escalation.
- Reports against unsupported local modifications.

## Supported Versions

Security fixes target `main` first and are released with the next available build.

## Dependency Alerts

Dependency alerts are tracked through GitHub Dependabot. If a dependency alert is already fixed on `main` but GitHub still shows it open, maintainers may dismiss it as stale after verifying the manifest and lockfile.
