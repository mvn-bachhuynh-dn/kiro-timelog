import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `kiro-timelog-test-${Date.now()}`);
const TEST_SESSIONS = join(TEST_DIR, 'sessions');
const TEST_TIMELOG = join(TEST_DIR, 'timelog');
process.env.AILOG_DIR = TEST_TIMELOG;
process.env.CLAUDE_HISTORY_FILE = '/dev/null';
process.env.CLAUDE_DIR = '/nonexistent';
process.env.CODEX_DB_PATH = '/nonexistent/codex.sqlite';
process.env.GEMINI_DIR = '/nonexistent';

const { loadConfig, detectProject, matchTicket, getOS, detectProjectFromText, isParentProject } = await import('../lib/config.mjs');
const { scanSessions } = await import('../scripts/scan.mjs');
const { calculateActiveTime, loadEvents } = await import('../scripts/report.mjs');

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function setup() {
  mkdirSync(TEST_SESSIONS, { recursive: true });
  mkdirSync(TEST_TIMELOG, { recursive: true });
  writeFileSync(join(TEST_TIMELOG, 'config.json'), JSON.stringify({
    ticketPatterns: ['([A-Z][A-Z0-9]+-\\d+)'],
    projectPattern: '/home/user/projects/([^/]+)',
    breakThreshold: 1800
  }));
}

function clean() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

function createSession(id, opts = {}) {
  const session = {
    session_id: id,
    cwd: opts.cwd || '/home/user/projects/my-app',
    created_at: opts.created_at || '2026-06-15T09:00:00.000Z',
    updated_at: opts.updated_at || '2026-06-15T10:00:00.000Z',
    title: opts.title || 'test',
    session_state: {
      agent_name: 'dev',
      conversation_metadata: {
        user_turn_metadatas: opts.turns || [
          { end_timestamp: '2026-06-15T09:05:00.000Z', user_prompt_length: 20, metering_usage: [{ value: 0.1, unit: 'credit' }] },
          { end_timestamp: '2026-06-15T09:10:00.000Z', user_prompt_length: 30, metering_usage: [{ value: 0.2, unit: 'credit' }] },
        ]
      }
    }
  };
  writeFileSync(join(TEST_SESSIONS, `${id}.json`), JSON.stringify(session));
  if (opts.prompts) writeFileSync(join(TEST_SESSIONS, `${id}.history`), opts.prompts.join('\n'));
}

function readAllEvents() {
  const events = [];
  if (!existsSync(TEST_TIMELOG)) return events;
  for (const f of readdirSync(TEST_TIMELOG).filter(f => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(TEST_TIMELOG, f), 'utf8').split('\n').filter(Boolean)) {
      try { events.push(JSON.parse(line)); } catch {}
    }
  }
  return events;
}

// ═══════════════════════════════════════
// 1. Config (8 tests)
// ═══════════════════════════════════════

describe('Config', () => {
  it('loads defaults when no file', () => {
    const cfg = loadConfig('/nonexistent/path');
    assert.strictEqual(cfg.breakThreshold, 1800);
    assert.strictEqual(cfg.projectPattern, null);
    assert.deepStrictEqual(cfg.ticketPatterns, ['([A-Z][A-Z0-9]+-\\d+)']);
  });

  it('loads custom config', () => {
    setup();
    const cfg = loadConfig(TEST_TIMELOG);
    assert.strictEqual(cfg.projectPattern, '/home/user/projects/([^/]+)');
  });

  it('handles malformed JSON gracefully', () => {
    setup();
    writeFileSync(join(TEST_TIMELOG, 'config.json'), '{ broken json!!!');
    const cfg = loadConfig(TEST_TIMELOG);
    assert.strictEqual(cfg.breakThreshold, 1800); // Falls back to defaults
  });

  it('matchTicket JIRA-style', () => {
    const cfg = { ticketPatterns: ['([A-Z][A-Z0-9]+-\\d+)'] };
    assert.strictEqual(matchTicket('feature/BAN-123-fix', cfg), 'BAN-123');
    assert.strictEqual(matchTicket('PROJ-456 task', cfg), 'PROJ-456');
    assert.strictEqual(matchTicket('no ticket', cfg), null);
  });

  it('matchTicket null/empty', () => {
    const cfg = { ticketPatterns: ['([A-Z]+-\\d+)'] };
    assert.strictEqual(matchTicket(null, cfg), null);
    assert.strictEqual(matchTicket('', cfg), null);
    assert.strictEqual(matchTicket('abc', { ticketPatterns: [] }), null);
  });

  it('matchTicket multiple patterns (first wins)', () => {
    const cfg = { ticketPatterns: ['([A-Z][A-Z0-9]+-\\d+)', '#(\\d+)'] };
    assert.strictEqual(matchTicket('fix #42', cfg), '42');
    assert.strictEqual(matchTicket('BAN-99 #42', cfg), 'BAN-99');
  });

  it('detectProject from pattern', () => {
    const cfg = { projectPattern: '/home/user/projects/([^/]+)', projectSource: 'git-root' };
    assert.strictEqual(detectProject('/home/user/projects/my-app', cfg), 'my-app');
    assert.strictEqual(detectProject('/home/user/projects/api-v2', cfg), 'api-v2');
  });

  it('detectProject cwd fallback', () => {
    const cfg = { projectPattern: null, projectSource: 'cwd' };
    assert.strictEqual(detectProject('/some/path/cool-project', cfg), 'cool-project');
    assert.strictEqual(detectProject(null, cfg), 'unknown');
  });
});

// ═══════════════════════════════════════
// 2. Scan (8 tests)
// ═══════════════════════════════════════

describe('Scan', () => {
  beforeEach(() => { clean(); setup(); });

  it('generates correct events', () => {
    createSession('s001', { prompts: ['hello', 'fix bug'] });
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    assert.strictEqual(r.newSessions, 1);
    assert.strictEqual(r.newEvents, 4);
    const events = readAllEvents();
    assert.strictEqual(events[0].event, 'SessionStart');
    assert.strictEqual(events[3].event, 'SessionEnd');
  });

  it('stores prompt text', () => {
    createSession('s002', { prompts: ['hello world', 'deploy'] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const prompts = readAllEvents().filter(e => e.event === 'UserPromptSubmit');
    assert.strictEqual(prompts[0].prompt, 'hello world');
    assert.strictEqual(prompts[1].prompt, 'deploy');
  });

  it('detects project from cwd', () => {
    createSession('s003', { cwd: '/home/user/projects/cool-app' });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    assert.strictEqual(readAllEvents()[0].project, 'cool-app');
  });

  it('incremental skips processed', () => {
    createSession('s004');
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    assert.strictEqual(r.newSessions, 0);
  });

  it('re-scans updated sessions', () => {
    createSession('s005', { updated_at: '2026-06-15T10:00:00.000Z' });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    createSession('s005', { updated_at: '2026-06-15T11:00:00.000Z' });
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    assert.strictEqual(r.newSessions, 1);
  });

  it('handles empty turns', () => {
    createSession('s006', { turns: [] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const events = readAllEvents().filter(e => e.session === 's006');
    assert.strictEqual(events.length, 2); // Start + End
  });

  it('stores credits', () => {
    createSession('s007', {
      turns: [{ end_timestamp: '2026-06-15T09:05:00.000Z', user_prompt_length: 20, metering_usage: [{ value: 0.5, unit: 'credit' }, { value: 0.3, unit: 'credit' }] }]
    });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const prompt = readAllEvents().find(e => e.event === 'UserPromptSubmit' && e.session === 's007');
    assert.ok(Math.abs(prompt.credits - 0.8) < 0.001);
  });

  it('no null fields in output', () => {
    createSession('s008', { turns: [{ end_timestamp: '2026-06-15T09:05:00.000Z', user_prompt_length: 20, metering_usage: [] }] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const events = readAllEvents().filter(e => e.session === 's008');
    for (const e of events) {
      for (const [k, v] of Object.entries(e)) {
        assert.notStrictEqual(v, null, `Field "${k}" should not be null`);
        assert.notStrictEqual(v, undefined, `Field "${k}" should not be undefined`);
      }
    }
  });
});

// ═══════════════════════════════════════
// 3. Edge Cases (7 tests)
// ═══════════════════════════════════════

describe('Edge Cases', () => {
  beforeEach(() => { clean(); setup(); });

  it('sessions dir does not exist → no error', () => {
    const r = scanSessions('/nonexistent/dir', TEST_TIMELOG);
    assert.strictEqual(r.newSessions, 0);
    assert.strictEqual(r.error, null);
  });

  it('sessions dir empty → 0 sessions', () => {
    setup();
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    assert.strictEqual(r.newSessions, 0);
  });

  it('corrupted session JSON → skipped', () => {
    setup();
    writeFileSync(join(TEST_SESSIONS, 'bad.json'), 'not json at all!!!');
    createSession('good');
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    assert.strictEqual(r.newSessions, 1); // Only good session
  });

  it('session missing required fields → skipped', () => {
    setup();
    writeFileSync(join(TEST_SESSIONS, 'incomplete.json'), JSON.stringify({ session_id: 'x' }));
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    assert.strictEqual(r.newSessions, 0);
  });

  it('missing .history file → no prompts, no error', () => {
    setup();
    createSession('no-history'); // No prompts option = no .history file
    // Explicitly remove history file
    try { rmSync(join(TEST_SESSIONS, 'no-history.history')); } catch {}
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    assert.strictEqual(r.newSessions, 1);
    const prompts = readAllEvents().filter(e => e.event === 'UserPromptSubmit' && e.session === 'no-history');
    assert.ok(prompts.every(p => !p.prompt)); // No prompt text
  });

  it('cwd that no longer exists → project = basename', () => {
    setup();
    createSession('old-cwd', { cwd: '/tmp/deleted-long-ago/my-project' });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const ev = readAllEvents().find(e => e.session === 'old-cwd');
    assert.strictEqual(ev.project, 'my-project');
  });

  it('very long prompt → truncated to 500 chars', () => {
    setup();
    const longPrompt = 'x'.repeat(1000);
    createSession('long', { prompts: [longPrompt], turns: [{ end_timestamp: '2026-06-15T09:05:00.000Z', user_prompt_length: 1000, metering_usage: [] }] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const prompt = readAllEvents().find(e => e.event === 'UserPromptSubmit' && e.session === 'long');
    assert.strictEqual(prompt.prompt.length, 500);
  });
});

// ═══════════════════════════════════════
// 4. Active Time (6 tests)
// ═══════════════════════════════════════

describe('Active Time', () => {
  it('consecutive events → active time', () => {
    const events = [
      { ts: '2026-06-15T09:00:00.000Z', session: 'x', project: 'app', event: 'Start' },
      { ts: '2026-06-15T09:05:00.000Z', session: 'x', project: 'app', event: 'Prompt' },
      { ts: '2026-06-15T09:10:00.000Z', session: 'x', project: 'app', event: 'Prompt' },
      { ts: '2026-06-15T09:15:00.000Z', session: 'x', project: 'app', event: 'End' },
    ];
    const total = calculateActiveTime(events, 1800).reduce((s, x) => s + x.duration, 0);
    assert.strictEqual(total, 900);
  });

  it('excludes breaks (gap > threshold)', () => {
    const events = [
      { ts: '2026-06-15T09:00:00.000Z', session: 'x', project: 'a', event: 'P' },
      { ts: '2026-06-15T09:05:00.000Z', session: 'x', project: 'a', event: 'P' },
      { ts: '2026-06-15T11:05:00.000Z', session: 'x', project: 'a', event: 'P' }, // 2h gap
      { ts: '2026-06-15T11:10:00.000Z', session: 'x', project: 'a', event: 'E' },
    ];
    const total = calculateActiveTime(events, 1800).reduce((s, x) => s + x.duration, 0);
    assert.strictEqual(total, 600);
  });

  it('multiple sessions independent', () => {
    const events = [
      { ts: '2026-06-15T09:00:00.000Z', session: 'a', project: 'p1', event: 'S' },
      { ts: '2026-06-15T09:10:00.000Z', session: 'a', project: 'p1', event: 'E' },
      { ts: '2026-06-15T09:00:00.000Z', session: 'b', project: 'p2', event: 'S' },
      { ts: '2026-06-15T09:20:00.000Z', session: 'b', project: 'p2', event: 'E' },
    ];
    const slices = calculateActiveTime(events, 1800);
    const p1 = slices.filter(s => s.project === 'p1').reduce((s, x) => s + x.duration, 0);
    const p2 = slices.filter(s => s.project === 'p2').reduce((s, x) => s + x.duration, 0);
    assert.strictEqual(p1, 600);
    assert.strictEqual(p2, 1200);
  });

  it('strict threshold (600s)', () => {
    const events = [
      { ts: '2026-06-15T09:00:00.000Z', session: 'x', project: 'a', event: 'P' },
      { ts: '2026-06-15T09:08:00.000Z', session: 'x', project: 'a', event: 'P' },
      { ts: '2026-06-15T09:20:00.000Z', session: 'x', project: 'a', event: 'P' }, // 12m gap > 600
    ];
    const slices = calculateActiveTime(events, 600);
    assert.strictEqual(slices.length, 1);
    assert.strictEqual(slices[0].duration, 480);
  });

  it('single event → no time', () => {
    const slices = calculateActiveTime([{ ts: '2026-06-15T09:00:00.000Z', session: 'x', project: 'a', event: 'S' }], 1800);
    assert.strictEqual(slices.length, 0);
  });

  it('empty events → no crash', () => {
    const slices = calculateActiveTime([], 1800);
    assert.strictEqual(slices.length, 0);
  });
});

// ═══════════════════════════════════════
// 5. Integration (5 tests)
// ═══════════════════════════════════════

describe('Integration', () => {
  beforeEach(() => { clean(); setup(); });

  it('full flow: scan → report', () => {
    createSession('i001', {
      cwd: '/home/user/projects/web-app',
      created_at: '2026-06-15T09:00:00.000Z', updated_at: '2026-06-15T09:30:00.000Z',
      turns: [
        { end_timestamp: '2026-06-15T09:05:00.000Z', user_prompt_length: 20, metering_usage: [] },
        { end_timestamp: '2026-06-15T09:10:00.000Z', user_prompt_length: 30, metering_usage: [] },
        { end_timestamp: '2026-06-15T09:20:00.000Z', user_prompt_length: 40, metering_usage: [] },
      ]
    });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const events = loadEvents(TEST_TIMELOG, new Date('2026-06-14'), new Date('2026-06-16'));
    const total = calculateActiveTime(events, 1800).reduce((s, x) => s + x.duration, 0);
    assert.strictEqual(total, 1800); // 30 min
  });

  it('ticket from prompt text', () => {
    createSession('i002', {
      cwd: '/home/user/projects/infra',
      turns: [{ end_timestamp: '2026-06-15T09:05:00.000Z', user_prompt_length: 30, metering_usage: [] }],
      prompts: ['fix NET-789 timeout']
    });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const prompt = readAllEvents().find(e => e.session === 'i002' && e.event === 'UserPromptSubmit');
    assert.strictEqual(prompt.ticket, 'NET-789');
  });

  it('multiple projects tracked', () => {
    createSession('i003', { cwd: '/home/user/projects/app-a', created_at: '2026-06-15T09:00:00.000Z', updated_at: '2026-06-15T09:30:00.000Z', turns: [{ end_timestamp: '2026-06-15T09:15:00.000Z', user_prompt_length: 20, metering_usage: [] }] });
    createSession('i004', { cwd: '/home/user/projects/app-b', created_at: '2026-06-15T14:00:00.000Z', updated_at: '2026-06-15T14:30:00.000Z', turns: [{ end_timestamp: '2026-06-15T14:15:00.000Z', user_prompt_length: 20, metering_usage: [] }] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const events = loadEvents(TEST_TIMELOG, new Date('2026-06-14'), new Date('2026-06-16'));
    const slices = calculateActiveTime(events, 1800);
    const a = slices.filter(s => s.project === 'app-a').reduce((s, x) => s + x.duration, 0);
    const b = slices.filter(s => s.project === 'app-b').reduce((s, x) => s + x.duration, 0);
    assert.strictEqual(a, 1800);
    assert.strictEqual(b, 1800);
  });

  it('multi-day creates separate files', () => {
    createSession('i005', { created_at: '2026-06-14T09:00:00.000Z', updated_at: '2026-06-14T10:00:00.000Z', turns: [] });
    createSession('i006', { created_at: '2026-06-15T09:00:00.000Z', updated_at: '2026-06-15T10:00:00.000Z', turns: [] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/dev/null');
    const files = readdirSync(TEST_TIMELOG).filter(f => f.endsWith('.jsonl'));
    assert.ok(files.length >= 2);
  });

  it('getOS returns macos or linux', () => {
    assert.ok(['macos', 'linux'].includes(getOS()));
  });
});

// ═══════════════════════════════════════
// 6. Claude Code Scanner (5 tests)
// ═══════════════════════════════════════

describe('Claude Code Scanner', () => {
  beforeEach(() => { clean(); setup(); });

  it('scans Claude history.jsonl', () => {
    const historyFile = join(TEST_DIR, 'claude_history.jsonl');
    const lines = [
      JSON.stringify({ display: 'fix the bug', timestamp: 1718600000000, project: '/home/user/projects/web-app', sessionId: 'claude-s1' }),
      JSON.stringify({ display: 'add tests', timestamp: 1718600300000, project: '/home/user/projects/web-app', sessionId: 'claude-s1' }),
    ];
    writeFileSync(historyFile, lines.join('\n') + '\n');
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, historyFile);
    assert.strictEqual(r.claude.sessions, 1);
    assert.strictEqual(r.claude.events, 2);
    const events = readAllEvents();
    const claudeEvents = events.filter(e => e.source === 'claude');
    assert.strictEqual(claudeEvents.length, 2);
    assert.strictEqual(claudeEvents[0].prompt, 'fix the bug');
    assert.strictEqual(claudeEvents[0].project, 'web-app');
  });

  it('incremental: only reads new lines', () => {
    const historyFile = join(TEST_DIR, 'claude_history.jsonl');
    writeFileSync(historyFile, JSON.stringify({ display: 'first', timestamp: 1718600000000, project: '/home/user/projects/app', sessionId: 's1' }) + '\n');
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, historyFile);
    appendFileSync(historyFile, JSON.stringify({ display: 'second', timestamp: 1718600600000, project: '/home/user/projects/app', sessionId: 's1' }) + '\n');
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, historyFile);
    assert.strictEqual(r.claude.events, 1);
  });

  it('skips /exit and command prompts', () => {
    const historyFile = join(TEST_DIR, 'claude_history.jsonl');
    const lines = [
      JSON.stringify({ display: '/exit', timestamp: 1718600000000, project: '/tmp', sessionId: 's1' }),
      JSON.stringify({ display: '/help', timestamp: 1718600100000, project: '/tmp', sessionId: 's1' }),
      JSON.stringify({ display: 'real prompt', timestamp: 1718600200000, project: '/home/user/projects/x', sessionId: 's1' }),
    ];
    writeFileSync(historyFile, lines.join('\n') + '\n');
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, historyFile);
    assert.strictEqual(r.claude.events, 1);
  });

  it('handles missing history file', () => {
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG, '/nonexistent/history.jsonl');
    assert.strictEqual(r.claude.sessions, 0);
  });

  it('detects ticket from Claude prompt', () => {
    const historyFile = join(TEST_DIR, 'claude_history.jsonl');
    writeFileSync(historyFile, JSON.stringify({ display: 'fix BAN-456 login issue', timestamp: 1718600000000, project: '/home/user/projects/app', sessionId: 's1' }) + '\n');
    scanSessions(TEST_SESSIONS, TEST_TIMELOG, historyFile);
    const events = readAllEvents().filter(e => e.source === 'claude');
    assert.strictEqual(events[0].ticket, 'BAN-456');
  });
});

// ═══════════════════════════════════════
// 7. Project Detection from Text (4 tests)
// ═══════════════════════════════════════

describe('Project Detection from Text', () => {
  it('detectProjectFromText extracts project from file paths', () => {
    const config = { projectPattern: '/Users/bach.huynh/projects/([^/]+)' };
    const text = 'fix /Users/bach.huynh/projects/my-app/src/index.ts';
    const result = detectProjectFromText(text, config, 'bach.huynh');
    assert.strictEqual(result, 'my-app');
  });

  it('returns most frequent project when multiple mentioned', () => {
    const config = { projectPattern: '/Users/bach.huynh/projects/([^/]+)' };
    const text = '/Users/bach.huynh/projects/app-a/x\n/Users/bach.huynh/projects/app-b/y\n/Users/bach.huynh/projects/app-b/z';
    const result = detectProjectFromText(text, config, 'fallback');
    assert.strictEqual(result, 'app-b');
  });

  it('returns fallback when no pattern matches', () => {
    const config = { projectPattern: '/Users/bach.huynh/projects/([^/]+)' };
    const text = 'just a regular prompt with no paths';
    const result = detectProjectFromText(text, config, 'bach.huynh');
    assert.strictEqual(result, 'bach.huynh');
  });

  it('isParentProject identifies generic parent dirs', () => {
    assert.strictEqual(isParentProject('projects'), true);
    assert.strictEqual(isParentProject('repos'), true);
    assert.strictEqual(isParentProject('src'), true);
    assert.strictEqual(isParentProject('my-real-app'), false);
    assert.strictEqual(isParentProject('nhakhoa-mental'), false);
  });
});

// ═══════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════
describe('Cleanup', () => {
  it('remove test dir', () => { clean(); assert.ok(true); });
});
