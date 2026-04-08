# TODO

## Test Updates

- Update outdated test expectations to match current behavior in `src/channels/discord.test.ts` and `src/codex-account.test.ts`.

## Manager Channel Parity

- Define the target scope for the Discord manager channel so it matches root Codex responsibilities without overexposing host control. Include concrete allowed operations, prohibited operations, and expected approval boundaries.
- Audit the current main-group capability gap versus root Codex. Focus on project visibility, writable surfaces, service control, git workflows, Docker/image operations, and environment/config editing.
- Decide which operations should stay host-mediated via IPC/MCP and which should remain unavailable from the Discord manager channel. Prefer explicit host tools over indirect shell work where possible.
- Add any missing manager-only host actions needed for project administration, such as safe service restart/rebuild flows, channel lifecycle management, and controlled repository maintenance tasks.
- Review main-group mounts and permissions so the manager channel can inspect the whole project safely, while code writes or destructive actions still require explicit, auditable pathways.
- Align manager-channel guidance in `groups/main/AGENTS.md` and `groups/main/docs/*` with the final authority model so the agent knows when to use IPC/MCP, when to inspect files directly, and when to stop for confirmation.
- Add verification coverage for manager-only capabilities and authorization boundaries, especially around IPC task handling, restart/build flows, and any new admin actions exposed to the main channel.
