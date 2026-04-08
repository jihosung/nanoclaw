# Group Management

Use this guide when you need to register, modify, or remove groups/channels from the main channel.

## Finding Available Groups

Available groups are provided in `/workspace/ipc/available_groups.json`:

```json
{
  "groups": [
    {
      "jid": "120363336345536173@g.us",
      "name": "Family Chat",
      "lastActivity": "2026-01-31T12:00:00.000Z",
      "isRegistered": false
    }
  ],
  "lastSync": "2026-01-31T12:00:00.000Z"
}
```

Groups are ordered by most recent activity. The list is synced from WhatsApp daily.

If a group the user mentions isn't in the list, request a fresh sync:

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

Then wait a moment and re-read `available_groups.json`.

Fallback: query the SQLite database directly:

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT jid, name, last_message_time
  FROM chats
  WHERE jid LIKE '%@g.us' AND jid != '__group_sync__'
  ORDER BY last_message_time DESC
  LIMIT 10;
"
```

## Registered Groups Config

Groups are registered in the SQLite `registered_groups` table:

```json
{
  "1234567890-1234567890@g.us": {
    "name": "Family Chat",
    "folder": "whatsapp_family-chat",
    "trigger": "@Andy",
    "added_at": "2024-01-31T12:00:00.000Z"
  }
}
```

Fields:
- Key: The chat JID (unique identifier across channels)
- `name`: Display name for the group
- `folder`: Channel-prefixed folder name under `groups/` for this group's files and memory
- `trigger`: The trigger word (usually same as global, but could differ)
- `requiresTrigger`: Whether `@trigger` prefix is needed (default: `true`). Set to `false` for solo/personal chats where all messages should be processed
- `isMain`: Whether this is the main control group (elevated privileges, no trigger required)
- `added_at`: ISO timestamp when registered

## Trigger Behavior

- Main group (`isMain: true`): no trigger needed, all messages are processed
- Groups with `requiresTrigger: false`: no trigger needed, all messages processed (use for 1-on-1 or solo chats)
- Other groups (default): messages must start with `@AssistantName` to be processed

## Adding a Group

1. Query the database to find the group's JID.
2. Use the `register_group` MCP tool with JID, name, folder, trigger, and optional `requiresTrigger` (set `false` for always-on channels).
3. Optionally include `containerConfig` for additional mounts.
4. The group folder is created automatically: `/workspace/project/groups/{folder-name}/`.
5. For non-main groups, keep that group's `AGENTS.md` channel-specific and lightweight:
   - Treat `/workspace/global/AGENTS.md` as the global baseline reference.
   - Put channel-specific behavior only in `/workspace/project/groups/<folder>/AGENTS.md`.
   - Start custom channel sections as placeholders and fill them only when the user asks.

Recommended initial block for non-main group AGENTS:

```md
## Global Baseline
Follow `/workspace/global/AGENTS.md` for shared defaults.

## Channel-Specific Overrides
<!-- Add channel-specific rules here only when requested. -->
```

Folder naming convention (channel prefix with underscore separator):
- WhatsApp "Family Chat" -> `whatsapp_family-chat`
- Telegram "Dev Team" -> `telegram_dev-team`
- Discord "General" -> `discord_general`
- Slack "Engineering" -> `slack_engineering`
- Use lowercase and hyphens for the name part

### Adding Additional Directories for a Group

Groups can have extra directories mounted. Add `containerConfig` to their entry:

```json
{
  "1234567890@g.us": {
    "name": "Dev Team",
    "folder": "dev-team",
    "trigger": "@Andy",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "~/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ]
    }
  }
}
```

The directory will appear at `/workspace/extra/webapp` in that group's container.

### Sender Allowlist

After registering a group, explain the sender allowlist feature to the user:

> This group can be configured with a sender allowlist to control who can interact with me. There are two modes:
>
> - Trigger mode (default): Everyone's messages are stored for context, but only allowed senders can trigger me with @{AssistantName}.
> - Drop mode: Messages from non-allowed senders are not stored at all.
>
> For closed groups with trusted members, I recommend setting up an allow-only list so only specific people can trigger me. Want me to configure that?

If the user wants to set up an allowlist, edit `~/.config/nanoclaw/sender-allowlist.json` on the host:

```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "<chat-jid>": {
      "allow": ["sender-id-1", "sender-id-2"],
      "mode": "trigger"
    }
  },
  "logDenied": true
}
```

Notes:
- Your own messages (`is_from_me`) explicitly bypass the allowlist in trigger checks.
- Bot messages are filtered out by the database query before trigger evaluation.
- If the config file doesn't exist or is invalid, all senders are allowed (fail-open).
- The config file is on the host at `~/.config/nanoclaw/sender-allowlist.json`, not inside the container.

## Removing a Group

1. Read `/workspace/project/data/registered_groups.json`.
2. Remove the entry for that group.
3. Write the updated JSON back.
4. The group folder and its files remain (do not delete them).

## Listing Groups

Read `/workspace/project/data/registered_groups.json` and format it clearly.

## Changing a Group Model

To change the model for a specific group, write an `update_model` IPC task:

```bash
echo '{"type":"update_model","jid":"<target-jid>","model":"gpt-5.4-mini"}' \
  > /workspace/ipc/tasks/update_model_$(date +%s).json
```

The change takes effect on the next message sent to that group.
