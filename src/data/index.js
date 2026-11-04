'use strict';
/** Snapshot assembly: system stats + providers + DSH session usage. */

const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { collectProviders } = require('./providers');
const { collectSessions } = require('./dsh');
const execFileAsync = promisify(execFile);
const CPU_MIN_SAMPLE_MS = 400;
const VM_STAT_TTL_MS = 3000;

let previousCpu = sampleCpuTimes();
let lastCpuPercent = 0;

function sampleCpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu && cpu.times;
    if (!times) continue;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total, at: Date.now(), cores: cpus.length };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function cpuSnapshot() {
  const next = sampleCpuTimes();
  if (next.at - previousCpu.at >= CPU_MIN_SAMPLE_MS && next.total > previousCpu.total) {
    const totalDelta = next.total - previousCpu.total;
    const idleDelta = next.idle - previousCpu.idle;
    lastCpuPercent = Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
    previousCpu = next;
  }
  const load = os.loadavg();
  return {
    percent: round(lastCpuPercent, 1),
    cores: next.cores,
    load: [round(load[0], 2), round(load[1], 2), round(load[2], 2)],
  };
}

let vmStatCache = { at: 0, value: null };

async function vmStatMemory() {
  if (vmStatCache.value && Date.now() - vmStatCache.at < VM_STAT_TTL_MS) return vmStatCache.value;
  const { stdout } = await execFileAsync('vm_stat', [], { timeout: 1500, maxBuffer: 1 << 20 });
  const pageMatch = /page size of (\d+) bytes/.exec(stdout);
  const pageSize = pageMatch ? Number(pageMatch[1]) : 4096;
  const pages = (label) => {
    const match = new RegExp(label + ':\\s+(\\d+)\\.?').exec(stdout);
    return match ? Number(match[1]) : 0;
  };
  const available =
    (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) *
    pageSize;
  const total = os.totalmem();
  vmStatCache = {
    at: Date.now(),
    value: { total, free: Math.min(available, total), used: Math.max(0, total - Math.min(available, total)), source: 'vm_stat' },
  };
  return vmStatCache.value;
}

async function memorySnapshot() {
  if (process.platform === 'darwin') {
    try {
      const value = await vmStatMemory();
      return { ...value, percent: round((value.used / value.total) * 100, 1) };
    } catch {
      /* fall through to the portable reading */
    }
  }
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  return { total, free, used, source: 'os', percent: round(total > 0 ? (used / total) * 100 : 0, 1) };
}

function processSnapshot() {
  const usage = process.memoryUsage();
  return { rss: usage.rss, heapUsed: usage.heapUsed, uptime: round(process.uptime(), 0) };
}

/**
 * One complete data snapshot for the renderer.
 * @param {{awaitInitial?: boolean}} options
 */
async function collectSnapshot(options = {}) {
  const [{ providers, settings }, sessionData] = await Promise.all([
    collectProviders({ awaitInitial: options.awaitInitial }),
    Promise.resolve(collectSessions()),
  ]);
  return {
    time: Date.now(),
    cpu: cpuSnapshot(),
    memory: await memorySnapshot(),
    process: processSnapshot(),
    providers,
    settings,
    totals: sessionData.totals,
    history: sessionData.history,
  };
}

module.exports = { collectSnapshot };
