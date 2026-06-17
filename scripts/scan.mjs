#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { KIRO_SESSIONS_DIR, CLAUDE_HISTORY_FILE, TIMELOG_DIR, loadConfig, detectProject, detectTicket, matchTicket } from '../lib/config.mjs';

function loadProcessed(dir) {
  try { return JSON.parse(readFileSync(join(dir, '.processed.json'), 'utf8')); } catch { return {}; }
}

function logEvent(timelogDir, entry) {
  const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v != null));
  appendFileSync(join(timelogDir, `${entry.ts.slice(0, 10)}.jsonl`), JSON.stringify(clean) + '\n');
}

// ─── Kiro CLI Scanner ────────────────────

function scanKiro(sessionsDir, timelogDir, config, processed) {
  if (!existsSync(sessionsDir)) return { sessions: 0, events: 0 };
  let files;
  try { files = readdirSync(sessionsDir).filter(f => f.endsWith('.json') && !f.includes('.lock')); } catch { return { sessions: 0, events: 0 }; }

  let sessions = 0, events = 0;
  for (const file of files) {
    let session;
    try { session = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')); } catch { continue; }
    const { session_id, cwd, created_at, updated_at, session_state } = session;
    if (!session_id || !cwd || !created_at) continue;
    const key = `kiro:${session_id}`;
    if (processed[key] === updated_at) continue;

    const project = detectProject(cwd, config);
    const ticket = detectTicket(cwd, config);
    const turns = session_state?.conversation_metadata?.user_turn_metadatas || [];
    let prompts = [];
    try { prompts = readFileSync(join(sessionsDir, `${session_id}.history`), 'utf8').split('\n').filter(Boolean); } catch {}

    logEvent(timelogDir, { ts: created_at, event: 'SessionStart', session: session_id, project, ticket, cwd, source: 'kiro' });
    events++;

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const ts = turn.end_timestamp || created_at;
      const prompt = (prompts[i] || '').slice(0, 500);
      const entry = { ts, event: 'UserPromptSubmit', session: session_id, project, cwd, source: 'kiro' };
      if (prompt) entry.prompt = prompt;
      const t = matchTicket(prompt, config) || ticket;
      if (t) entry.ticket = t;
      if (turn.metering_usage?.length) entry.credits = +(turn.metering_usage.reduce((s, m) => s + (m.value || 0), 0).toFixed(6));
      logEvent(timelogDir, entry);
      events++;
    }

    if (updated_at) {
      logEvent(timelogDir, { ts: updated_at, event: 'SessionEnd', session: session_id, project, ticket, cwd, source: 'kiro' });
      events++;
    }
    processed[key] = updated_at;
    sessions++;
  }
  return { sessions, events };
}

// ─── Claude Code Scanner ─────────────────

function scanClaude(historyFile, timelogDir, config, processed) {
  if (!existsSync(historyFile)) return { sessions: 0, events: 0 };
  let lines;
  try { lines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean); } catch { return { sessions: 0, events: 0 }; }

  const lastLine = processed['claude:lastLine'] || 0;
  if (lines.length <= lastLine) return { sessions: 0, events: 0 };

  const newLines = lines.slice(lastLine);
  let events = 0;
  const sessionsSeen = new Set();

  for (const line of newLines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.timestamp || !rec.sessionId) continue;

    const ts = new Date(rec.timestamp).toISOString();
    const cwd = rec.project || null;
    const project = cwd ? detectProject(cwd, config) : 'unknown';
    const prompt = (rec.display || '').slice(0, 500);
    if (!prompt || prompt.startsWith('/')) continue; // Skip commands like /exit

    const entry = { ts, event: 'UserPromptSubmit', session: rec.sessionId, project, cwd, source: 'claude' };
    if (prompt) entry.prompt = prompt;
    const ticket = matchTicket(prompt, config);
    if (ticket) entry.ticket = ticket;
    logEvent(timelogDir, entry);
    events++;
    sessionsSeen.add(rec.sessionId);
  }

  processed['claude:lastLine'] = lines.length;
  return { sessions: sessionsSeen.size, events };
}

// ─── Main ────────────────────────────────

export function scanSessions(kiroDir = KIRO_SESSIONS_DIR, timelogDir = TIMELOG_DIR, claudeFile = CLAUDE_HISTORY_FILE) {
  const config = loadConfig(timelogDir);
  mkdirSync(timelogDir, { recursive: true });
  const processed = loadProcessed(timelogDir);

  const kiro = scanKiro(kiroDir, timelogDir, config, processed);
  const claude = scanClaude(claudeFile, timelogDir, config, processed);

  writeFileSync(join(timelogDir, '.processed.json'), JSON.stringify(processed));
  return {
    newSessions: kiro.sessions + claude.sessions,
    newEvents: kiro.events + claude.events,
    kiro, claude, error: null
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = scanSessions();
  if (r.error) console.error(`Error: ${r.error}`);
  else {
    const parts = [];
    if (r.kiro.sessions) parts.push(`Kiro: ${r.kiro.sessions} sessions/${r.kiro.events} events`);
    if (r.claude.sessions) parts.push(`Claude: ${r.claude.sessions} sessions/${r.claude.events} events`);
    if (!parts.length) parts.push('No new data');
    console.log(`${parts.join(' | ')} → ${TIMELOG_DIR}`);
  }
}
