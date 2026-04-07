---
name: setup
description: Run first-time NanoClaw setup in Codex CLI (Discord-only). Use when user asks for initial installation, credentials, Discord registration, service startup, or end-to-end verification.
---

# NanoClaw Setup (Codex, Discord-only)

Run setup end-to-end from Codex CLI in this repo. This skill is the Codex equivalent of Claude `/setup`, scoped to Discord only.

## Rules

- Execute commands directly. Do not tell the user to run commands unless manual action is unavoidable (Discord portal actions, token retrieval).
- Pause only when required user input is missing.
- Prefer these setup steps in order:
  1. `git`
  2. `bootstrap`
  3. `environment`
  4. `timezone`
  5. `container`
  6. `credentials`
  7. `discord`
  8. `mounts`
  9. `service`
  10. `verify`

All steps are executed via:

```bash
npx tsx setup/index.ts --step <step> -- [args...]
```

## Inputs To Collect

- Runtime: `docker` or `apple-container`
- Credential mode: `subscription` or `api_key`
- Credential value:
  - subscription => Claude token from `claude setup-token`
  - api_key => Anthropic API key
- Discord bot token
- Discord main channel ID
- Mount mode: `empty` or custom JSON

## Execution Flow

### 1) Git

Run:

```bash
npx tsx setup/index.ts --step git
```

If failed, diagnose remotes and retry.

### 2) Bootstrap

Run:

```bash
npx tsx setup/index.ts --step bootstrap
```

If `STATUS != success`, use `logs/setup.log` and repair (Node/deps/native), then rerun.

### 3) Environment

Run:

```bash
npx tsx setup/index.ts --step environment
```

Record `DOCKER` / `APPLE_CONTAINER` for runtime selection.

### 4) Timezone

Run:

```bash
npx tsx setup/index.ts --step timezone
```

If `STATUS=needs_input`, ask for IANA timezone and rerun:

```bash
npx tsx setup/index.ts --step timezone -- --tz <IANA_TZ>
```

### 5) Container

Choose runtime and run:

```bash
npx tsx setup/index.ts --step container -- --runtime <docker|apple-container>
```

If failed, inspect `logs/setup.log`, fix runtime/build issue, retry.

### 6) Credentials

Run:

```bash
npx tsx setup/index.ts --step credentials -- --runtime <runtime> --mode <subscription|api_key> [--token <token>] [--api-key <key>]
```

Notes:
- Docker path prefers OneCLI if installed.
- If OneCLI is missing, fallback writes credentials to `.env`.

### 7) Discord Registration (Main Channel)

Run:

```bash
npx tsx setup/index.ts --step discord -- --token <discord_bot_token> --channel-id <channel_id> [--channel-name "<name>"] [--folder discord_main]
```

This writes `DISCORD_BOT_TOKEN`, syncs `data/env/env`, and registers main Discord group.

### 8) Mounts

Default safe mode:

```bash
npx tsx setup/index.ts --step mounts -- --empty
```

Or custom:

```bash
npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'
```

### 9) Service

Run:

```bash
npx tsx setup/index.ts --step service
```

If failed, diagnose service manager and logs (`logs/nanoclaw.error.log`), then retry.

### 10) Verify

Run:

```bash
npx tsx setup/index.ts --step verify
```

Success criteria:
- `SERVICE=running`
- `CREDENTIALS` configured
- `CHANNEL_AUTH` contains `discord`
- `REGISTERED_GROUPS > 0`

## Troubleshooting

- Build/dependency issues: inspect `logs/setup.log`
- Service issues: inspect `logs/nanoclaw.error.log`
- Discord not responding:
  - `DISCORD_BOT_TOKEN` exists in `.env`
  - `data/env/env` is synced
  - registered group JID begins with `dc:`
  - verify step passes

