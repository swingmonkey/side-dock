'use strict';
/**
 * Token usage from DSH session logs.
 *
 * DSH stores one append-only log per session:
 *   $DSH_HOME/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd
 * The file is a sequence of concatenated zstd frames (one per append), each
 * decoding to JSONL events. Node's zstd decompressor stops at the first frame,
 * so frames are split on the zstd magic number and decoded one by one.
 *
 * Nothing leaves the machine: the app only reads these files.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const RATE_WINDOW_MS = 30_000;

/** file path -> { signature, result } */
const cache = new Map();

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.jsonl\.zstd$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Decode every concatenated zstd frame in the buffer. */
function decodeFrames(data) {
  const starts = [];
  let index = 0;
  for (;;) {
    const found = data.indexOf(MAGIC, index);
    if (found === -1) break;
    starts.push(found);
    index = found + MAGIC.length;
  }
  starts.push(data.length);
  const chunks = [];
  for (let i = 0; i < starts.length - 1; i += 1) {
    try {
      chunks.push(zlib.zstdDecompressSync(data.subarray(starts[i], starts[i + 1])));
    } catch {
      // A false-positive magic inside compressed bytes: skip that slice.
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // truncated tail while DSH is appending
    }
  }
  return events;
}

function summarize(events, file) {
  let header = null;
  let title = '';
  let model = null;
  let contextWindow = null;
  let contextTokens = null;
  let running = false;
  let lastActivity = 0;
  let createdAt = null;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, total: 0 };
  const timeline = []; // [time, tokens] for day/month/rate buckets

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const time = typeof event.time === 'number' ? event.time : 0;
    if (time > lastActivity) lastActivity = time;

    switch (event.type) {
      case 'session':
        header = event;
        createdAt = typeof event.createdAt === 'number' ? event.createdAt : null;
        break;
      case 'session/title': {
        const data = event.data;
        if (data && typeof data.title === 'string' && data.title) title = data.title;
        break;
      }
      case 'request/context': {
        const data = event.data || {};
        if (data.model) model = data.model;
        if (typeof data.contextWindow === 'number') contextWindow = data.contextWindow;
        break;
      }
      case 'request/header': {
        const config = event.data && event.data.header && event.data.header.config;
        if (config && config.model) model = config.model;
        break;
      }
      case 'turn/start':
        running = true;
        break;
      case 'turn/end':
        running = false;
        break;
      case 'assistant/message': {
        const record = event.data && event.data.usage;
        if (!record) break;
        usage.calls += 1;
        usage.input += record.inputTokens || 0;
        usage.output += record.outputTokens || 0;
        usage.cacheRead += record.cacheReadTokens || 0;
        usage.cacheWrite += record.cacheWriteTokens || 0;
        usage.reasoning += record.reasoningTokens || 0;
        const total = (record.inputTokens || 0) + (record.outputTokens || 0);
        usage.total += total;
        timeline.push([time, total]);
        contextTokens = record.inputTokens || 0;
        break;
      }
      default:
        break;
    }
  }

  const id =
    (header && header.id) ||
    (path.basename(path.dirname(file)) || '').replace(/^session-/, 'session-');
  const session = {
    id,
    title,
    running,
    model,
    contextWindow,
    contextTokens,
    usage,
    totalTokens: usage.total,
    lastActivity,
    createdAt,
    cwd: (header && header.cwd) || null,
  };
  return { session, timeline };
}

function readSessionFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const signature = `${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(file);
  if (cached && cached.signature === signature) return cached.parsed;

  let parsed;
  try {
    const text = decodeFrames(fs.readFileSync(file));
    parsed = summarize(parseEvents(text), file);
  } catch {
    return cached ? cached.parsed : null;
  }
  cache.set(file, { signature, parsed });
  return parsed;
}

/** Drop cache entries for files that no longer exist (keeps memory bounded). */
function pruneCache(liveFiles) {
  for (const key of cache.keys()) {
    if (!liveFiles.has(key)) cache.delete(key);
  }
}

/**
 * Scan every DSH session log and aggregate the numbers the widget shows.
 * @param {{now?: number}} options
 */
function collectSessions(options = {}) {
  const now = options.now || Date.now();
  const files = walk(sessionsRoot(), []);
  const live = new Set(files);
  pruneCache(live);

  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  const rateSince = now - RATE_WINDOW_MS;

  const sessions = [];
  const totals = { sessions: 0, running: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  let today = 0;
  let month = 0;
  let recent = 0;

  for (const file of files) {
    const parsed = readSessionFile(file);
    if (!parsed) continue;
    const { session, timeline } = parsed;
    sessions.push(session);
    totals.sessions += 1;
    if (session.running) totals.running += 1;
    totals.input += session.usage.input;
    totals.output += session.usage.output;
    totals.cacheRead += session.usage.cacheRead;
    totals.cacheWrite += session.usage.cacheWrite;
    totals.reasoning += session.usage.reasoning;
    totals.total += session.usage.total;
    for (const [time, tokens] of timeline) {
      if (time >= dayStart) today += tokens;
      if (time >= monthStart) month += tokens;
      if (time >= rateSince) recent += tokens;
    }
  }

  sessions.sort((left, right) => {
    if (left.running !== right.running) return left.running ? -1 : 1;
    return right.lastActivity - left.lastActivity;
  });

  return {
    sessions,
    totals,
    history: {
      today,
      month,
      ratePerSecond: Math.round((recent / (RATE_WINDOW_MS / 1000)) * 10) / 10,
    },
  };
}

module.exports = { collectSessions, sessionsRoot, decodeFrames };
