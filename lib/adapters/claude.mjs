import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectProject, matchTicket, detectProjectFromText, isParentProject } from '../config.mjs';

export const name = 'claude';
const CLAUDE_DIR = process.env.CLAUDE_DIR || join(homedir(), '.claude');
export const defaultDir = process.env.CLAUDE_HISTORY_FILE || join(CLAUDE_DIR, 'history.jsonl');

export function scan(historyFile, config, processed, emit) {
  let events = 0;
  const sessionsSeen = new Set();

  // Source 1: history.jsonl (global — all accounts)
  events += scanHistory(historyFile, config, processed, emit, sessionsSeen);

  // Source 2: sessions/*.json (session metadata with startedAt, cwd)
  events += scanSessionMeta(config, processed, emit, sessionsSeen);

  return { sessions: sessionsSeen.size, events };
}

function scanHistory(historyFile, config, processed, emit, sessionsSeen) {
  if (!existsSync(historyFile)) return 0;
  let lines;
  try { lines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean); } catch { return 0; }

  const lastLine = processed['claude:lastLine'] || 0;
  if (lines.length <= lastLine) return 0;

  const newLines = lines.slice(lastLine);
  let events = 0;

  for (const line of newLines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.timestamp || !rec.sessionId) continue;

    const ts = new Date(rec.timestamp).toISOString();
    const cwd = rec.project || null;
    let project = cwd ? detectProject(cwd, config) : 'unknown';
    const prompt = (rec.display || '').slice(0, 500);
    if (!prompt || prompt.startsWith('/')) continue;

    // If project is a parent dir, try to detect from prompt text
    if (isParentProject(project, cwd)) {
      project = detectProjectFromText(prompt, config, project);
    }

    const entry = { ts, event: 'UserPromptSubmit', session: rec.sessionId, project, cwd, source: 'claude' };
    if (prompt) entry.prompt = prompt;
    const ticket = matchTicket(prompt, config);
    if (ticket) entry.ticket = ticket;
    emit(entry);
    events++;
    sessionsSeen.add(rec.sessionId);
  }

  processed['claude:lastLine'] = lines.length;
  return events;
}

function scanSessionMeta(config, processed, emit, sessionsSeen) {
  const sessionsDir = join(CLAUDE_DIR, 'sessions');  if (!existsSync(sessionsDir)) return 0;

  let files;
  try { files = readdirSync(sessionsDir).filter(f => f.endsWith('.json')); } catch { return 0; }

  let events = 0;
  for (const file of files) {
    let meta;
    try { meta = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')); } catch { continue; }
    if (!meta.sessionId || !meta.startedAt) continue;

    const key = `claude:session:${meta.sessionId}`;
    if (processed[key]) continue;

    // Only emit SessionStart if we haven't seen this session from history
    if (!sessionsSeen.has(meta.sessionId)) {
      const cwd = meta.cwd || null;
      const project = cwd ? detectProject(cwd, config) : 'unknown';
      emit({ ts: new Date(meta.startedAt).toISOString(), event: 'SessionStart', session: meta.sessionId, project, cwd, source: 'claude' });
      events++;
      sessionsSeen.add(meta.sessionId);
    }
    processed[key] = true;
  }
  return events;
}
