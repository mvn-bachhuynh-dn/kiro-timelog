import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Kiro CLI sessions
export const KIRO_SESSIONS_DIR = process.env.KIRO_SESSIONS_DIR || join(homedir(), '.kiro', 'sessions', 'cli');
// Claude Code history
export const CLAUDE_HISTORY_FILE = process.env.CLAUDE_HISTORY_FILE || join(homedir(), '.claude', 'history.jsonl');
// Output
export const TIMELOG_DIR = process.env.AILOG_DIR || process.env.KIRO_TIMELOG_DIR || join(homedir(), '.ailog');

const DEFAULT_CONFIG = {
  ticketPatterns: ['([A-Z][A-Z0-9]+-\\d+)'],
  projectSource: 'git-root',
  projectPattern: null,
  breakThreshold: 1800,
};

export function loadConfig(dir) {
  const configDir = dir || TIMELOG_DIR;
  try {
    const raw = readFileSync(join(configDir, 'config.json'), 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function detectProject(cwd, config) {
  if (!cwd) return 'unknown';
  if (config.projectPattern) {
    try {
      const m = cwd.match(new RegExp(config.projectPattern));
      if (m) return m[1] || m[0];
    } catch {}
  }
  if (config.projectSource === 'cwd') return basename(cwd);
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000
    }).trim();
    return basename(root || cwd);
  } catch {
    return basename(cwd);
  }
}

export function detectTicket(cwd, config) {
  if (!cwd) return null;
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000
    }).trim();
    if (branch) return matchTicket(branch, config);
  } catch {}
  return null;
}

export function matchTicket(text, config) {
  if (!text) return null;
  for (const pat of (config.ticketPatterns || [])) {
    try {
      const m = text.match(new RegExp(pat));
      if (m) return m[1] || m[0];
    } catch {}
  }
  return null;
}

export function getOS() {
  return process.platform === 'darwin' ? 'macos' : 'linux';
}
