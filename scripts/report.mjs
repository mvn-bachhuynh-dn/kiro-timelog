#!/usr/bin/env node
// Generate reports from JSONL timelog files.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIMELOG_DIR, loadConfig } from '../lib/config.mjs';

function parseArgs(argv) {
  const args = { period: 'week' };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--week': args.period = 'week'; break;
      case '--month': args.period = 'month'; break;
      case '--from': args.from = argv[++i]; break;
      case '--to': args.to = argv[++i]; break;
      case '--timesheet': args.view = 'timesheet'; break;
      case '--by-project': args.view = 'by-project'; break;
      case '--by-day': args.view = 'by-day'; break;
      case '--project': args.filterProject = argv[++i]; break;
      case '--json': args.json = true; break;
    }
  }
  return args;
}

function getDateRange(args) {
  const now = new Date();
  let from, to;
  if (args.from) { from = new Date(args.from); to = args.to ? new Date(args.to) : now; }
  else if (args.period === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to = now;
  } else {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    from = monday; to = now;
  }
  return { from, to };
}

export function loadEvents(timelogDir = TIMELOG_DIR, from, to) {
  const events = [];
  const files = readdirSync(timelogDir).filter(f => f.endsWith('.jsonl'));
  for (const file of files) {
    const date = file.replace('.jsonl', '');
    if (from && date < from.toISOString().slice(0, 10)) continue;
    if (to && date > to.toISOString().slice(0, 10)) continue;
    const lines = readFileSync(join(timelogDir, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch {}
    }
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function calculateActiveTime(events, breakThreshold) {
  // Group by session, calculate time between consecutive events
  const sessions = {};
  for (const e of events) {
    (sessions[e.session] ||= []).push(e);
  }

  const slices = []; // { project, ticket, date, duration, session }
  for (const [sessionId, evts] of Object.entries(sessions)) {
    for (let i = 0; i < evts.length - 1; i++) {
      const gap = (new Date(evts[i + 1].ts) - new Date(evts[i].ts)) / 1000;
      if (gap > 0 && gap <= breakThreshold) {
        slices.push({
          project: evts[i].project || 'unknown',
          ticket: evts[i].ticket || null,
          date: evts[i].ts.slice(0, 10),
          duration: gap,
          session: sessionId,
        });
      }
    }
  }
  return slices;
}

function formatDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function countPrompts(events, filter) {
  return events.filter(e => e.event === 'UserPromptSubmit' && (!filter || filter(e))).length;
}

function printReport(slices, events, args) {
  if (!slices.length) { console.log('No data for the selected period.'); return; }

  if (args.view === 'timesheet') {
    // Project x Ticket summary
    const grouped = {};
    for (const s of slices) {
      const key = s.project;
      grouped[key] ||= { total: 0, tickets: {} };
      grouped[key].total += s.duration;
      if (s.ticket) {
        grouped[key].tickets[s.ticket] = (grouped[key].tickets[s.ticket] || 0) + s.duration;
      }
    }
    console.log('Project / Ticket'.padEnd(30) + 'Active'.padStart(10) + 'Prompts'.padStart(10));
    console.log('─'.repeat(50));
    for (const [proj, data] of Object.entries(grouped).sort((a, b) => b[1].total - a[1].total)) {
      const prompts = countPrompts(events, e => e.project === proj);
      console.log(proj.padEnd(30) + formatDuration(data.total).padStart(10) + String(prompts).padStart(10));
      for (const [ticket, dur] of Object.entries(data.tickets).sort((a, b) => b[1] - a[1])) {
        const tp = countPrompts(events, e => e.project === proj && e.ticket === ticket);
        console.log(('  ' + ticket).padEnd(30) + formatDuration(dur).padStart(10) + String(tp).padStart(10));
      }
    }
  } else if (args.view === 'by-project') {
    const grouped = {};
    for (const s of slices) { grouped[s.project] = (grouped[s.project] || 0) + s.duration; }
    console.log('Project'.padEnd(30) + 'Active'.padStart(10));
    console.log('─'.repeat(40));
    for (const [proj, dur] of Object.entries(grouped).sort((a, b) => b - a)) {
      console.log(proj.padEnd(30) + formatDuration(dur).padStart(10));
    }
  } else if (args.view === 'by-day') {
    const grouped = {};
    for (const s of slices) { grouped[s.date] = (grouped[s.date] || 0) + s.duration; }
    console.log('Date'.padEnd(15) + 'Active'.padStart(10));
    console.log('─'.repeat(25));
    for (const [date, dur] of Object.entries(grouped).sort()) {
      console.log(date.padEnd(15) + formatDuration(dur).padStart(10));
    }
  } else {
    // Default: day x project
    const grouped = {};
    for (const s of slices) {
      const key = `${s.date}|${s.project}`;
      grouped[key] = (grouped[key] || 0) + s.duration;
    }
    console.log('Date'.padEnd(13) + 'Project'.padEnd(25) + 'Active'.padStart(10) + 'Prompts'.padStart(10));
    console.log('─'.repeat(58));
    for (const [key, dur] of Object.entries(grouped).sort()) {
      const [date, proj] = key.split('|');
      const prompts = countPrompts(events, e => e.ts.startsWith(date) && e.project === proj);
      console.log(date.padEnd(13) + proj.padEnd(25) + formatDuration(dur).padStart(10) + String(prompts).padStart(10));
    }
  }

  // Total
  const totalSecs = slices.reduce((s, x) => s + x.duration, 0);
  const totalPrompts = countPrompts(events, () => true);
  const sessions = new Set(slices.map(s => s.session)).size;
  console.log('─'.repeat(58));
  console.log(`Total: ${formatDuration(totalSecs)} active | ${totalPrompts} prompts | ${sessions} sessions`);
}

// Run
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const { from, to } = getDateRange(args);
  const events = loadEvents(TIMELOG_DIR, from, to);

  if (args.filterProject) {
    const filtered = events.filter(e => e.project === args.filterProject);
    const slices = calculateActiveTime(filtered, config.breakThreshold);
    if (args.json) { console.log(JSON.stringify({ slices, totalActive: slices.reduce((s, x) => s + x.duration, 0) })); }
    else printReport(slices, filtered, args);
  } else {
    const slices = calculateActiveTime(events, config.breakThreshold);
    if (args.json) { console.log(JSON.stringify({ slices, totalActive: slices.reduce((s, x) => s + x.duration, 0) })); }
    else printReport(slices, events, args);
  }
}
