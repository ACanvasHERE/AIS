<p align="right">
  <a href="./README.md">简体中文</a> | English | <a href="./README.ko.md">한국어</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.fr.md">Français</a>
</p>

# AIS

> A local command-line tool you can install with a single `npm` command to help protect passwords, keys, and connection strings when using AI agents.

`AIS` is built around a simple goal:

- You can still hand secrets to AI so it can do real work
- The AI should see as little real secret data as possible
- Real secrets should be restored only on your own machine when they are actually needed
- The workflow should still succeed normally

<p align="center">
  <img src="./docs/images/readme-flow-en.jpg" alt="AIS workflow: a real password is replaced locally, the cloud AI only sees a placeholder token, and the real password is restored locally only when needed" width="100%" />
</p>

## Install In One Line

```bash
npm install -g @tokentestai/ais
```

After installation, the command name is `ais`.

In most cases, opening a new terminal once is enough for AIS to start protecting `claude`, `codex`, and `openclaw` automatically.

## How To Confirm It Is Active

Open a new terminal, then run:

```bash
ais protect status
type -a claude codex openclaw
```

You should see:

- all three tools show `applied=yes` in `ais protect status`
- `claude` and `openclaw` resolve to `~/.ais/bin/...` first
- `codex` may still show the original `~/.npm-global/bin/codex` path, which is normal because AIS can take it over in place

If the system keychain is unavailable, or macOS shows a keychain dialog, set a local password first:

```bash
export AIS_VAULT_PASSWORD='your-local-password'
```

Then open a new terminal and run the check commands again.

Current status:

- Native support for `macOS` and `Linux`
- `Windows` support is still being expanded
- Native support for `Claude Code`, `Codex`, and `OpenClaw`

## What Problem Does It Solve?

More and more people now give website passwords, server passwords, database URLs, API keys, and other sensitive values to AI agents so the agents can log in, deploy, edit config files, fill forms, and run commands.

That is convenient, and it is clearly becoming part of everyday workflows.

But the problem is also obvious:

- If you give the AI the **real password in plain text**, that password may enter the AI-visible path
- Once the real password leaves your machine, it becomes much harder to control what logs, support systems, storage layers, or downstream services may touch it
- If you use official APIs or third-party API providers, those providers may still be in a technical position to observe request contents

`AIS` is trying to solve one thing:

**Do not let the real password leave your machine unless it absolutely has to.**

## The Easiest Way To Understand It

Suppose you ask an AI agent to log into a website for you, and the real password is:

```text
qwert123
```

`AIS` first replaces it locally with a placeholder token such as:

```text
__SECRET_01__
```

At that point:

- the AI sees `__SECRET_01__`
- the AI provider sees `__SECRET_01__`
- the real `qwert123` is not directly sent out

Later, when the AI actually needs to perform the login on your machine, `AIS` locally restores:

```text
__SECRET_01__ -> qwert123
```

So the website still receives the correct real password `qwert123`, and the task does not fail just because a protection layer was added.

## How It Works

The full process can be explained in 5 steps:

1. You give the AI a real password, key, or connection string so it can complete a task.
2. `AIS` detects that sensitive value locally and replaces it with a placeholder token.
3. When data goes to the cloud, the AI sees the placeholder token instead of the real value.
4. When the AI is actually executing a local command, filling a form, or writing config on your machine, `AIS` restores the real value locally.
5. The task still completes, but the real secret tries not to leave your machine.

In plain language:

- hide it locally before sending
- restore it locally only when actually needed

## Why We Built It

We are heavy users of `Claude Code`, `Codex`, and `OpenClaw` ourselves.

We believe people will continue giving AI agents more permissions, not fewer.

The question is not whether AI should help with real work.

The real question is:

**Can we give AI more authority without letting real passwords travel around in plain text?**

That is the reason `AIS` exists:

- local-first
- open source
- minimal friction
- focused on one practical layer of risk reduction

## What You Can Use It For

- Let an AI log into websites without sending the real website password to the cloud in plain text
- Let an AI operate servers without exposing the raw server password to outside model pipelines
- Let an AI write config files, call APIs, and run scripts without directly exposing keys and connection strings
- Keep the convenience of automation while reducing unnecessary secret exposure

## Quick Start

Create local config first:

```bash
ais config
```

If you want to manually save a secret first:

```bash
ais add github-token
ais add github-token ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Wrap `Claude Code`:

```bash
ais claude
```

Wrap `Codex`:

```bash
ais -- codex --sandbox danger-full-access
```

Wrap `OpenClaw`:

```bash
ais -- openclaw <the arguments you would normally run>
```

## Terminal UI

`AIS` also includes a terminal UI so you can:

- review which values were successfully protected
- mark some values as “do not protect”
- inspect and adjust local behavior

Open it with:

```bash
ais ais
```

For example:

```bash
ais ais exclude <id>
ais ais exclude-type PASSWORD
```

## Why “Local-Only” Matters

The point is not to make secrets look prettier.

The point is this:

**real passwords should stay on your machine whenever possible.**

If the real password still needs to travel out, you still lose direct control over what may happen later.

`AIS` is trying to keep the most important steps local:

- local detection
- local replacement
- local restoration
- local execution

## Current Limits

We do not present this as a magical security tool.

It is useful, but it does not solve everything.

Important limits:

- If your local machine is already compromised, this will not save you
- It is not a permission system and does not replace least privilege, auditing, or isolation
- If a placeholder token is split, transformed, or rewritten, restoration may fail in some cases
- If a tool chain completely bypasses the locally visible layers, protection may be limited

So the accurate claim is:

`AIS` helps **reduce the chance that real secrets leave your machine**, but it does not mean “everything is safe forever.”

## Who Is It For?

- People who already use AI agents for real operational work
- People who want to give AI more authority but do not want plain-text passwords floating around
- People using official APIs or third-party API providers who want one more local layer of control
- People who want better automation without a large usability penalty

## Local Validation

If you want to validate the current version locally:

```bash
npm install
npm run lint
npm run build
npm run test
npm run typecheck
```

## Open Source

This is a local-first open source tool.

It is not trying to replace every part of your security model.

It is trying to fix one of the most common and practical problems in modern AI workflows:

**if you must give a password to AI, do not send the real password out in plain text first.**

## License

MIT
