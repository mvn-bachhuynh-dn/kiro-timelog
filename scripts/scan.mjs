#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SESSIONS_DIR, TIMELOG_DIR, loadConfig, detectProject, detectTicket, matchTicket } from '../lib/config.mjs';

function loadProcessed(dir) {
  try { return JSON.parse(readFileSync(join(dir, '.processed.json'), 'utf8')); } catch { return {}; }
}

export function scanSessions(sessionsDir = SESSIONS_DIR, timelogDir = TIMELOG_DIR) {
  // Graceful: if sessions dir doesn't exist, nothing to scan
  if (!existsSync(sessionsDir)) {
    return { newSessions: 0, newEvents: 0, error: null };
  }

  const config = loadConfig(timelogDir);
  mkdirSync(timelogDir, { recursive: true });

  const processed = loadProcessed(timelogDir);
  let files;
  try {
    files = readdirSync(sessionsDir).filter(f => f.endsWith('.json') && !f.includes('.lock'));
  } catch {
    return { newSessions: 0, newEvents: 0, error: 'Cannot read sessions directory' };
  }

  let newSessions = 0, newEvents = 0;

  for (const file of files) {
    let session;
    try { session = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')); } catch { continue; }

    const { session_id, cwd, created_at, updated_at, session_state } = session;
    if (!session_id || !cwd || !created_at) continue;
    if (processed[session_id] === updated_at) continue;

    const project = detectProject(cwd, config);
    const ticket = detectTicket(cwd, config);
    const turns = session_state?.conversation_metadata?.user_turn_metadatas || [];
    let prompts = [];
    try { prompts = readFileSync(join(sessionsDir, `${session_id}.history`), 'utf8').split('\n').filter(Boolean); } catch {}

    const log = (entry) => {
      const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v != null));
      appendFileSync(join(timelogDir, `${entry.ts.slice(0, 10)}.jsonl`), JSON.stringify(clean) + '\n');
    };

    log({ ts: created_at, event: 'SessionStart', session: session_id, project, ticket, cwd });
    newEvents++;

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const ts = turn.end_timestamp || created_at;
      const prompt = (prompts[i] || '').slice(0, 500);
      const entry = { ts, event: 'UserPromptSubmit', session: session_id, project, cwd };
      if (prompt) entry.prompt = prompt;
      const t = matchTicket(prompt, config) || ticket;
      if (t) entry.ticket = t;
      if (turn.metering_usage?.length) {
        entry.credits = +(turn.metering_usage.reduce((s, m) => s + (m.value || 0), 0).toFixed(6));
      }
      log(entry);
      newEvents++;
    }

    if (updated_at) {
      log({ ts: updated_at, event: 'SessionEnd', session: session_id, project, ticket, cwd });
      newEvents++;
    }

    processed[session_id] = updated_at;
    newSessions++;
  }

  writeFileSync(join(timelogDir, '.processed.json'), JSON.stringify(processed));
  return { newSessions, newEvents, error: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = scanSessions();
  if (r.error) console.error(`Error: ${r.error}`);
  else console.log(`Scanned: ${r.newSessions} sessions, ${r.newEvents} events → ${TIMELOG_DIR}`);
}
