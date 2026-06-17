#!/usr/bin/env node
// Cross-platform scheduler: launchd (macOS), cron or systemd (Linux)

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT = join(__dirname, 'scan.mjs');
const NODE_PATH = process.execPath;
const INTERVAL = 300; // 5 minutes

function getNodePath() {
  // Resolve actual node binary for scheduler config
  try {
    const resolved = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
    return resolved || NODE_PATH;
  } catch {
    return NODE_PATH;
  }
}

// ─── macOS: launchd ──────────────────────

function launchdPlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', 'com.ailog.scan.plist');
}

function installLaunchd() {
  const plistDir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(plistDir, { recursive: true });
  const plist = launchdPlistPath();
  const node = getNodePath();
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ailog.scan</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${SCAN_SCRIPT}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${dirname(node)}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>${INTERVAL}</integer>
  <key>StandardOutPath</key>
  <string>/tmp/kiro-timelog.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/kiro-timelog.err</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
  writeFileSync(plist, content);
  try { execSync(`launchctl unload "${plist}" 2>/dev/null`); } catch {}
  execSync(`launchctl load "${plist}"`);
  console.log(`✓ launchd agent installed: ${plist}`);
  console.log('  Runs every 5 min + on login');
}

function uninstallLaunchd() {
  const plist = launchdPlistPath();
  if (existsSync(plist)) {
    try { execSync(`launchctl unload "${plist}" 2>/dev/null`); } catch {}
    unlinkSync(plist);
    console.log('✓ launchd agent removed');
  } else {
    console.log('No launchd agent found');
  }
}

// ─── Linux: cron ─────────────────────────

const CRON_MARKER = '# ailog auto-scan';

function installCron() {
  const node = getNodePath();
  const cronLine = `*/${Math.round(INTERVAL / 60)} * * * * ${node} ${SCAN_SCRIPT} >> /tmp/kiro-timelog.log 2>&1 ${CRON_MARKER}`;
  let existing = '';
  try { existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }); } catch {}

  if (existing.includes(CRON_MARKER)) {
    // Replace existing
    const lines = existing.split('\n').filter(l => !l.includes(CRON_MARKER));
    lines.push(cronLine);
    execSync(`echo "${lines.join('\n')}" | crontab -`);
    console.log('✓ cron job updated (every 5 min)');
  } else {
    const newCrontab = existing.trimEnd() + '\n' + cronLine + '\n';
    execSync(`echo "${newCrontab}" | crontab -`);
    console.log('✓ cron job installed (every 5 min)');
  }
}

function uninstallCron() {
  let existing = '';
  try { existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }); } catch {}
  if (existing.includes(CRON_MARKER)) {
    const lines = existing.split('\n').filter(l => !l.includes(CRON_MARKER));
    execSync(`echo "${lines.join('\n')}" | crontab -`);
    console.log('✓ cron job removed');
  } else {
    console.log('No cron job found');
  }
}

// ─── Main ────────────────────────────────

const action = process.argv[2];
const os = platform();

if (action === 'install') {
  if (os === 'darwin') installLaunchd();
  else installCron();
} else if (action === 'uninstall') {
  if (os === 'darwin') uninstallLaunchd();
  else uninstallCron();
} else if (action === 'status') {
  if (os === 'darwin') {
    const plist = launchdPlistPath();
    if (existsSync(plist)) {
      try {
        const out = execSync('launchctl list | grep ailog', { encoding: 'utf8' });
        console.log(`Active: ${out.trim()}`);
      } catch { console.log('Installed but not running'); }
    } else { console.log('Not installed'); }
  } else {
    try {
      const cron = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
      if (cron.includes(CRON_MARKER)) console.log('Active: cron job installed');
      else console.log('Not installed');
    } catch { console.log('Not installed'); }
  }
} else {
  console.log('Usage: node scheduler.mjs <install|uninstall|status>');
}
