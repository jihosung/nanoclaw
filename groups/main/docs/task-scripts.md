# Task Scripts and Cross-Group Scheduling

Use this guide for recurring tasks and script-gated schedules.

## Scheduling for Other Groups

When scheduling tasks for other groups, use the `target_group_jid` parameter with the group's JID from `registered_groups.json`:

- `schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "120363336345536173@g.us")`

The task runs in that group's context with access to their files and memory.

## Task Scripts

For recurring tasks, prefer `schedule_task` with a `script` whenever a simple pre-check can decide whether agent wake-up is needed.

### How it works

1. You provide a bash `script` alongside the `prompt` when scheduling.
2. When the task fires, the script runs first (30-second timeout).
3. Script prints JSON to stdout: `{ "wakeAgent": true/false, "data": {...} }`.
4. If `wakeAgent: false`, nothing else happens and the task waits for next run.
5. If `wakeAgent: true`, the agent is invoked and receives the script data with the prompt.

### Always test scripts first

Before scheduling, run the script in your sandbox:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When not to use scripts

If a task requires agent judgment every time (daily briefings, reminders, reports), skip the script and use a regular prompt.

### Frequent-task guidance

If a user requests high frequency (more than ~2 times/day) and scripts cannot reduce wake-ups:

- Explain that each wake-up consumes API credits and can hit rate limits.
- Suggest restructuring with a script pre-check.
- If LLM evaluation is still needed, suggest using a direct API call inside the script instead of waking the full agent.
- Help pick the minimum viable frequency.
