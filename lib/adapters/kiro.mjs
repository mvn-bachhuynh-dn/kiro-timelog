import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectProject, detectTicket, matchTicket, detectProjectFromText, isParentProject } from '../config.mjs';

export const name = 'kiro';
export const defaultDir = process.env.KIRO_SESSIONS_DIR || join(homedir(), '.kiro', 'sessions', 'cli');

export function scan(dir, config, processed, emit) {
  if (!existsSync(dir)) return { sessions: 0, events: 0 };
  let files;
  try { files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.lock')); } catch { return { sessions: 0, events: 0 }; }

  let sessions = 0, events = 0;
  for (const file of files) {
    let session;
    try { session = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
    const { session_id, cwd, created_at, updated_at, session_state } = session;
    if (!session_id || !cwd || !created_at) continue;
    const key = `kiro:${session_id}`;
    if (processed[key] === updated_at) continue;

    const project = detectProject(cwd, config);
    const ticket = detectTicket(cwd, config);
    const turns = session_state?.conversation_metadata?.user_turn_metadatas || [];
    let prompts = [];
    try { prompts = readFileSync(join(dir, `${session_id}.history`), 'utf8').split('\n').filter(Boolean); } catch {}

    // If project is a parent dir, try to detect from prompt text
    const effectiveProject = isParentProject(project, cwd)
      ? detectProjectFromText(prompts.join('\n'), config, project)
      : project;

    emit({ ts: created_at, event: 'SessionStart', session: session_id, project: effectiveProject, ticket, cwd, source: 'kiro' });
    events++;

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const ts = turn.end_timestamp || created_at;
      const prompt = (prompts[i] || '').slice(0, 500);
      const entry = { ts, event: 'UserPromptSubmit', session: session_id, project: effectiveProject, cwd, source: 'kiro' };
      if (prompt) entry.prompt = prompt;
      const t = matchTicket(prompt, config) || ticket;
      if (t) entry.ticket = t;
      if (turn.metering_usage?.length) entry.credits = +(turn.metering_usage.reduce((s, m) => s + (m.value || 0), 0).toFixed(6));
      emit(entry);
      events++;
    }

    if (updated_at) {
      emit({ ts: updated_at, event: 'SessionEnd', session: session_id, project: effectiveProject, ticket, cwd, source: 'kiro' });
      events++;
    }
    processed[key] = updated_at;
    sessions++;
  }
  return { sessions, events };
}
