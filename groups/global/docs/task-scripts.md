# Task Scripts

Use this guide for recurring tasks and conditional wake-up scripts.

## When to use scripts

For recurring tasks, prefer `schedule_task` with a `script` if a quick pre-check can decide whether wake-up is needed.

## How it works

1. Provide a bash `script` together with the scheduled `prompt`.
2. When the task fires, the script runs first (30-second timeout).
3. Script outputs JSON: `{ "wakeAgent": true/false, "data": {...} }`.
4. If `wakeAgent: false`, no agent call is made.
5. If `wakeAgent: true`, the agent is invoked with prompt + script data.

## Always test first

Run the script in sandbox before scheduling:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

## When not to use scripts

If a task needs agent judgment every run (daily briefings, reminders, reports), use regular prompts without scripts.

## Frequent-task guidance

If requested frequency is high (more than about 2/day) and scripts cannot reduce wake-ups:

- explain credit/rate-limit impact
- suggest script pre-checks first
- if LLM evaluation is still needed, suggest direct API calls in script instead of waking full agent
- help pick minimum viable frequency
