import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `kiro-timelog-test-${Date.now()}`);
const TEST_SESSIONS = join(TEST_DIR, 'sessions');
const TEST_TIMELOG = join(TEST_DIR, 'timelog');
process.env.KIRO_TIMELOG_DIR = TEST_TIMELOG;

const { loadConfig, detectProject, matchTicket, getOS } = await import('../lib/config.mjs');
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
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    assert.strictEqual(r.newSessions, 1);
    assert.strictEqual(r.newEvents, 4);
    const events = readAllEvents();
    assert.strictEqual(events[0].event, 'SessionStart');
    assert.strictEqual(events[3].event, 'SessionEnd');
  });

  it('stores prompt text', () => {
    createSession('s002', { prompts: ['hello world', 'deploy'] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    const prompts = readAllEvents().filter(e => e.event === 'UserPromptSubmit');
    assert.strictEqual(prompts[0].prompt, 'hello world');
    assert.strictEqual(prompts[1].prompt, 'deploy');
  });

  it('detects project from cwd', () => {
    createSession('s003', { cwd: '/home/user/projects/cool-app' });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    assert.strictEqual(readAllEvents()[0].project, 'cool-app');
  });

  it('incremental skips processed', () => {
    createSession('s004');
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    assert.strictEqual(r.newSessions, 0);
  });

  it('re-scans updated sessions', () => {
    createSession('s005', { updated_at: '2026-06-15T10:00:00.000Z' });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    createSession('s005', { updated_at: '2026-06-15T11:00:00.000Z' });
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    assert.strictEqual(r.newSessions, 1);
  });

  it('handles empty turns', () => {
    createSession('s006', { turns: [] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    const events = readAllEvents().filter(e => e.session === 's006');
    assert.strictEqual(events.length, 2); // Start + End
  });

  it('stores credits', () => {
    createSession('s007', {
      turns: [{ end_timestamp: '2026-06-15T09:05:00.000Z', user_prompt_length: 20, metering_usage: [{ value: 0.5, unit: 'credit' }, { value: 0.3, unit: 'credit' }] }]
    });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    const prompt = readAllEvents().find(e => e.event === 'UserPromptSubmit' && e.session === 's007');
    assert.ok(Math.abs(prompt.credits - 0.8) < 0.001);
  });

  it('no null fields in output', () => {
    createSession('s008', { turns: [{ end_timestamp: '2026-06-15T09:05:00.000Z', user_prompt_length: 20, metering_usage: [] }] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
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
  beforeEach(() => { clean(); });

  it('sessions dir does not exist → no error', () => {
    const r = scanSessions('/nonexistent/dir', TEST_TIMELOG);
    assert.strictEqual(r.newSessions, 0);
    assert.strictEqual(r.error, null);
  });

  it('sessions dir empty → 0 sessions', () => {
    setup();
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    assert.strictEqual(r.newSessions, 0);
  });

  it('corrupted session JSON → skipped', () => {
    setup();
    writeFileSync(join(TEST_SESSIONS, 'bad.json'), 'not json at all!!!');
    createSession('good');
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    assert.strictEqual(r.newSessions, 1); // Only good session
  });

  it('session missing required fields → skipped', () => {
    setup();
    writeFileSync(join(TEST_SESSIONS, 'incomplete.json'), JSON.stringify({ session_id: 'x' }));
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    assert.strictEqual(r.newSessions, 0);
  });

  it('missing .history file → no prompts, no error', () => {
    setup();
    createSession('no-history'); // No prompts option = no .history file
    // Explicitly remove history file
    try { rmSync(join(TEST_SESSIONS, 'no-history.history')); } catch {}
    const r = scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    assert.strictEqual(r.newSessions, 1);
    const prompts = readAllEvents().filter(e => e.event === 'UserPromptSubmit' && e.session === 'no-history');
    assert.ok(prompts.every(p => !p.prompt)); // No prompt text
  });

  it('cwd that no longer exists → project = basename', () => {
    setup();
    createSession('old-cwd', { cwd: '/tmp/deleted-long-ago/my-project' });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    const ev = readAllEvents().find(e => e.session === 'old-cwd');
    assert.strictEqual(ev.project, 'my-project');
  });

  it('very long prompt → truncated to 500 chars', () => {
    setup();
    const longPrompt = 'x'.repeat(1000);
    createSession('long', { prompts: [longPrompt], turns: [{ end_timestamp: '2026-06-15T09:05:00.000Z', user_prompt_length: 1000, metering_usage: [] }] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
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
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
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
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    const prompt = readAllEvents().find(e => e.session === 'i002' && e.event === 'UserPromptSubmit');
    assert.strictEqual(prompt.ticket, 'NET-789');
  });

  it('multiple projects tracked', () => {
    createSession('i003', { cwd: '/home/user/projects/app-a', created_at: '2026-06-15T09:00:00.000Z', updated_at: '2026-06-15T09:30:00.000Z', turns: [{ end_timestamp: '2026-06-15T09:15:00.000Z', user_prompt_length: 20, metering_usage: [] }] });
    createSession('i004', { cwd: '/home/user/projects/app-b', created_at: '2026-06-15T14:00:00.000Z', updated_at: '2026-06-15T14:30:00.000Z', turns: [{ end_timestamp: '2026-06-15T14:15:00.000Z', user_prompt_length: 20, metering_usage: [] }] });
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
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
    scanSessions(TEST_SESSIONS, TEST_TIMELOG);
    const files = readdirSync(TEST_TIMELOG).filter(f => f.endsWith('.jsonl'));
    assert.ok(files.length >= 2);
  });

  it('getOS returns macos or linux', () => {
    assert.ok(['macos', 'linux'].includes(getOS()));
  });
});

// ═══════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════
describe('Cleanup', () => {
  it('remove test dir', () => { clean(); assert.ok(true); });
});
