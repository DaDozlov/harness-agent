# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use **Report a vulnerability** on the repository's Security tab (GitHub's private vulnerability reporting). Say what an attacker can do, how to reproduce it, and which version you used. You will get an answer within a week.

## Supported versions

The latest release gets security fixes.

## What heaw protects, and what it does not

heaw decides which tool calls an agent may make (permission modes and rules, protected files, approvals), keeps secrets out of logs, traces and commands, and checks where `web_fetch` leads. In a local workspace it cannot confine what a command does once it runs: an allowed command runs with your rights. For unattended runs with commands allowed, use the Docker workspace. The security model, its limits and the reasons are in [docs/DESIGN.md §8](docs/DESIGN.md#8-security-model).
