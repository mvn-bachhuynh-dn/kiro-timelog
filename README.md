# ailog

[![CI](https://github.com/mvn-bachhuynh-dn/ailog/actions/workflows/ci.yml/badge.svg)](https://github.com/mvn-bachhuynh-dn/ailog/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@steveh204/ailog)](https://www.npmjs.com/package/@steveh204/ailog)

Automatic time tracking for AI coding assistants. Passively scans session data from multiple AI CLI tools and reports active working time per project — perfect for freelance billing.

## Supported Tools

| Tool | Data Source | What's Tracked |
|------|-------------|----------------|
| Kiro CLI | `~/.kiro/sessions/cli/` | Prompts, credits, cwd |
| Claude Code | `~/.claude/history.jsonl` + `sessions/` | Prompts, cwd, multi-account |
| OpenAI Codex | `~/.codex/state_5.sqlite` | Threads, cwd, git branch |
| Google Gemini | `~/.gemini/tmp/*/chats/` | Prompts, project mapping |

## Install

```bash
# npm (recommended)
npm install -g @steveh204/ailog

# Homebrew (macOS)
brew tap mvn-bachhuynh-dn/tap && brew install kiro-timelog

# Manual
git clone https://github.com/mvn-bachhuynh-dn/ailog.git
cd ailog && bash install.sh
```

## Usage

```bash
ailog                    # This week's report
ailog --month            # This month
ailog --by-tool          # Group by AI tool
ailog --by-project       # Group by project
ailog --by-day           # Group by day
ailog --timesheet        # Project × ticket summary
ailog --from 2026-06-01 --to 2026-06-15  # Custom range
ailog --project myapp    # Filter by project
ailog --json             # JSON output
```

### Example Output

```
Date         Project               Tool      Active  Prompts
────────────────────────────────────────────────────────────
2026-06-17   nhakhoa-mental        kiro      2h 41m       23
2026-06-17   mvn-claude-mgmt       kiro      1h 54m       33
2026-06-17   mvn-claude-mgmt       claude       45m       12
2026-06-17   ai-usage              kiro      1h 42m       29
──────────────────────────────────────────────────────────
Total: 7h 2m active | 97 prompts | 8 sessions
```

## Auto-Scan (Background)

```bash
ailog install-scheduler    # Scan every 5 minutes (launchd on macOS, cron on Linux)
ailog uninstall-scheduler  # Disable
```

Without the scheduler, `ailog` scans on demand each time you run it.

## Configuration

Optional config at `~/.ailog/config.json`:

```json
{
  "projectPattern": "/Users/you/projects/([^/]+)",
  "ticketPatterns": ["([A-Z][A-Z0-9]+-\\d+)"],
  "breakThreshold": 1800
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `projectPattern` | null | Regex on cwd → project name (capture group 1) |
| `ticketPatterns` | JIRA-style | Regex array for ticket detection from prompts/branches |
| `breakThreshold` | 1800 | Seconds; gaps longer than this are excluded from active time |
| `projectSource` | "git-root" | Fallback: use git root basename or cwd basename |

## How It Works

1. **Scan** — Reads session files from each AI tool (passive, no hooks needed)
2. **Emit** — Writes timestamped events to `~/.ailog/YYYY-MM-DD.jsonl`
3. **Report** — Calculates "active time" between consecutive prompts (excluding breaks)

Active time = time between prompts where gap < breakThreshold. Includes AI processing + output review time. Excludes idle breaks.

## Environment Variables

| Variable | Override |
|----------|---------|
| `AILOG_DIR` | Output directory (default: `~/.ailog/`) |
| `KIRO_SESSIONS_DIR` | Kiro sessions path |
| `CLAUDE_HISTORY_FILE` | Claude history.jsonl path |
| `CLAUDE_DIR` | Claude base directory |
| `CODEX_DB_PATH` | Codex SQLite path |
| `GEMINI_DIR` | Gemini base directory |

## Requirements

- Node.js ≥ 18
- macOS or Linux
- `sqlite3` CLI (only needed for Codex adapter)

## Development

```bash
git clone https://github.com/mvn-bachhuynh-dn/ailog.git
cd ailog
node --test test/test.mjs    # 40 tests
node scripts/scan.mjs        # Manual scan
node scripts/report.mjs      # Direct report
```

## License

MIT
