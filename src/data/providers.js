'use strict';
/**
 * Credit / quota providers for the standalone app.
 *
 * Key resolution order (first hit wins):
 *   1. environment variable (DEEPSEEK_API_KEY / OPENCODE_GO_API_KEY)
 *   2. the DSH credential store, read-only: ~/.dsh/.credentials.yaml `refs:`
 *      (the same refs the DSH profile uses, so no retyping keys)
 *   3. ~/.side-dock/config.json  { "deepseekApiKey": "...", "opencodeApiKey": "..." }
 *
 * Reads are cached (60s TTL) and refreshed in the background so the 2s UI poll
 * never waits on the network. A failed refresh keeps the last good value.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TTL_MS = 60_000;
const DEEPSEEK_URL = 'https://api.deepseek.com/user/balance';
const ZEN_URL = 'https://opencode.ai/zen/go/v1/usage';
const DEEPSEEK_LINKS = {
  usageUrl: 'https://platform.deepseek.com/usage',
  topUpUrl: 'https://platform.deepseek.com/top_up',
};

const state = {
  deepseek: { value: null, at: 0, pending: null, error: null },
  zen: { value: null, at: 0, pending: null, error: null },
};

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function readDshCredential(name) {
  try {
    const text = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8');
    const match = new RegExp('^\\s+' + name + ':\\s*(.+?)\\s*$', 'm').exec(text);
    if (!match) return null;
    const value = match[1].replace(/^["']|["']$/g, '');
    return value || null;
  } catch {
    return null;
  }
}

function readLocalConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.side-dock', 'config.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveKey(envName, configName) {
  if (process.env[envName]) return process.env[envName];
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return fromDsh;
  const local = readLocalConfig();
  return typeof local[configName] === 'string' && local[configName] ? local[configName] : null;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function refreshDeepSeek(key) {
  if (state.deepseek.pending) return state.deepseek.pending;
  state.deepseek.pending = (async () => {
    try {
      const response = await fetch(DEEPSEEK_URL, {
        headers: { authorization: `Bearer ${key}`, 'user-agent': 'side-dock' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const infos = Array.isArray(body && body.balance_infos) ? body.balance_infos : [];
      if (infos.length === 0) throw new Error('响应缺少 balance_infos');
      state.deepseek.value = {
        available: body.is_available !== false,
        wallets: infos.map((wallet) => ({
          currency: (wallet && wallet.currency) || 'CNY',
          total: safeNumber(wallet && wallet.total_balance),
          granted: safeNumber(wallet && wallet.granted_balance),
          toppedUp: safeNumber(wallet && wallet.topped_up_balance),
        })),
      };
      state.deepseek.at = Date.now();
      state.deepseek.error = null;
    } catch (error) {
      state.deepseek.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.deepseek.pending = null;
    }
  })();
  return state.deepseek.pending;
}

function readUsageWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const percent = Number(raw.percent);
  return {
    status: typeof raw.status === 'string' ? raw.status : 'ok',
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
  };
}

async function refreshZen(key) {
  if (state.zen.pending) return state.zen.pending;
  state.zen.pending = (async () => {
    try {
      const response = await fetch(ZEN_URL, {
        headers: { authorization: `Bearer ${key}`, 'user-agent': 'side-dock' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const usage = body && body.usage;
      if (!usage || typeof usage !== 'object') throw new Error('响应缺少 usage');
      state.zen.value = {
        rolling: readUsageWindow(usage.rolling),
        weekly: readUsageWindow(usage.weekly),
        monthly: readUsageWindow(usage.monthly),
      };
      state.zen.at = Date.now();
      state.zen.error = null;
    } catch (error) {
      state.zen.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.zen.pending = null;
    }
  })();
  return state.zen.pending;
}

function startIfStale(kind, key, refresh) {
  const entry = state[kind];
  const stale = !entry.value || Date.now() - entry.at > TTL_MS;
  if (stale && !entry.pending) void refresh(key);
  return entry.pending;
}

/**
 * Snapshot of both providers.
 * @param {{awaitInitial?: boolean}} options — awaitInitial waits for the first
 *   network answer (used by `--dump-stats` and the first paint).
 */
async function collectProviders(options = {}) {
  const deepseekKey = resolveKey('DEEPSEEK_API_KEY', 'deepseekApiKey');
  const zenKey = resolveKey('OPENCODE_GO_API_KEY', 'opencodeApiKey');

  const waits = [];
  if (deepseekKey) waits.push(startIfStale('deepseek', deepseekKey, refreshDeepSeek));
  if (zenKey) waits.push(startIfStale('zen', zenKey, refreshZen));
  if (options.awaitInitial && waits.length) await Promise.all(waits);

  const deepseek = state.deepseek;
  let account;
  if (!deepseekKey) {
    account = { status: 'signed-out', source: 'api-key', links: DEEPSEEK_LINKS, error: '未配置 DEEPSEEK_API_KEY' };
  } else if (deepseek.value) {
    account = {
      status: 'signed-in',
      source: 'api-key',
      provider: 'deepseek-official',
      wallets: deepseek.value.wallets,
      available: deepseek.value.available,
      at: deepseek.at,
      links: DEEPSEEK_LINKS,
      error: deepseek.error || undefined,
    };
  } else if (deepseek.error) {
    account = { status: 'error', source: 'api-key', links: DEEPSEEK_LINKS, error: deepseek.error };
  } else {
    account = { status: 'loading', source: 'api-key', links: DEEPSEEK_LINKS };
  }

  const zen = state.zen;
  let zenSnapshot;
  if (!zenKey) {
    zenSnapshot = { status: 'no-key', error: '未配置 OPENCODE_GO_API_KEY' };
  } else if (zen.value) {
    zenSnapshot = { status: 'ok', ...zen.value, at: zen.at, error: zen.error || undefined };
  } else if (zen.error) {
    zenSnapshot = { status: 'error', error: zen.error };
  } else {
    zenSnapshot = { status: 'loading' };
  }

  return { account, zen: zenSnapshot };
}

module.exports = { collectProviders };
