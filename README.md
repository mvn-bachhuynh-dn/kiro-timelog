# kiro-timelog

Automatic time tracking for [Kiro CLI](https://kiro.dev) sessions. Generates reports for freelance billing and productivity insights.

**How it works:** Reads Kiro CLI session data (`~/.kiro/sessions/cli/`), calculates active time between prompts, and generates daily JSONL logs. A background scheduler keeps it up to date automatically.

## Install

### npm (recommended)

```bash
npm install -g kiro-timelog
kirolog install-scheduler   # auto-scan every 5 min
```

### Homebrew (macOS)

```bash
brew tap bachvh/tap
brew install kiro-timelog
kirolog install-scheduler
```

### Manual

```bash
git clone https://github.com/bachvh/kiro-timelog.git
cd kiro-timelog
bash install.sh
```

### Requirements

- **Node.js >= 18** (only dependency)
- **macOS** or **Linux**
- **Kiro CLI** installed and used at least once

## Usage

```bash
kirolog                    # this week's report
kirolog --month            # this month
kirolog --timesheet        # project × ticket summary
kirolog --by-day           # daily breakdown
kirolog --by-project       # per-project totals
kirolog --project myapp    # filter single project
kirolog --from 2026-06-01 --to 2026-06-15  # custom range
kirolog --json             # JSON output for automation
```

### Example output

```
Date         Project                      Active   Prompts
──────────────────────────────────────────────────────────
2026-06-15   web-app                      5h 35m        31
2026-06-16   api-server                   2h 18m        14
2026-06-17   infra                           45m        11
──────────────────────────────────────────────────────────
Total: 8h 38m active | 56 prompts | 12 sessions
```

### Scheduler

```bash
kirolog install-scheduler    # enable auto-scan (launchd/cron)
kirolog uninstall-scheduler  # disable
```

- **macOS:** launchd agent (runs every 5 min + on login)
- **Linux:** cron job (every 5 min)

## Configuration

Optional. Create `~/.kiro/timelog/config.json`:

```json
{
  "ticketPatterns": ["([A-Z][A-Z0-9]+-\\d+)"],
  "projectSource": "git-root",
  "projectPattern": null,
  "breakThreshold": 1800
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `projectPattern` | Regex on cwd path. Capture group 1 = project name | `null` (uses git root) |
| `projectSource` | Fallback: `"git-root"` or `"cwd"` | `"git-root"` |
| `ticketPatterns` | Array of regex to extract ticket IDs from prompts/branches | Jira-style |
| `breakThreshold` | Seconds. Gaps larger than this = break (excluded from active time) | `1800` (30 min) |

### Project detection

Set `projectPattern` to extract project names from your directory structure:

```json
// ~/projects/my-app → "my-app"
{ "projectPattern": "/home/you/projects/([^/]+)" }

// ~/code/client/project → "project"
{ "projectPattern": "/home/you/code/[^/]+/([^/]+)" }
```

If not set, falls back to git repository name or directory basename.

### Ticket detection

Tickets are auto-detected from:
1. Git branch name (e.g. `feature/BAN-123-fix` → `BAN-123`)
2. Prompt text (e.g. "fix BAN-123 login" → `BAN-123`)

## How active time works

- Time between consecutive events within a session is "active time"
- Gaps **under** `breakThreshold` → counted as work time
- Gaps **over** `breakThreshold` → break (excluded)
- Includes AI processing time + your review time
- Good metric for billing: represents the session of focused work

## Environment variables

| Variable | Description |
|----------|-------------|
| `KIRO_SESSIONS_DIR` | Override Kiro sessions path (default: `~/.kiro/sessions/cli`) |
| `KIRO_TIMELOG_DIR` | Override timelog output path (default: `~/.kiro/timelog`) |

## Development

```bash
git clone https://github.com/bachvh/kiro-timelog.git
cd kiro-timelog
node --test test/test.mjs   # 35 tests
```

Zero external dependencies. Uses only Node.js built-in modules.

## Troubleshooting

### No data in report

```bash
# Check Kiro sessions exist
ls ~/.kiro/sessions/cli/*.json 2>/dev/null | wc -l

# Run scan manually
node scripts/scan.mjs

# Check timelog files
ls ~/.kiro/timelog/*.jsonl
```

### Wrong project name

Check `projectPattern` in `~/.kiro/timelog/config.json` matches your actual directories:
```bash
# See what cwd Kiro recorded
cat ~/.kiro/sessions/cli/<uuid>.json | grep cwd
```

### Scheduler not running

```bash
# Check status
npx kiro-timelog install-scheduler status

# macOS: check launchd
launchctl list | grep kiro

# Linux: check cron
crontab -l | grep kiro
```

## License

MIT
