'use strict';
/**
 * Provider registry: every balance / quota source is declared here, so the UI
 * can list them, toggle them and render them without provider-specific code.
 *
 * Two kinds:
 *   balance — one number (¥88.42, $12.30). Rendered as a big value + sub line.
 *   quota   — one or more usage windows, each with percent + reset time.
 *
 * Key resolution order (first hit wins):
 *   1. environment variable (DEEPSEEK_API_KEY, OPENROUTER_API_KEY, …)
 *   2. the DSH credential store, read-only: ~/.dsh/.credentials.yaml `refs:`
 *   3. ~/.side-dock/config.json  { "deepseekApiKey": "...", … }
 *
 * Reads are cached (60s TTL) and refreshed in the background, so the 2s UI poll
 * never waits on the network. A failed refresh keeps the last good value.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConfig, normalizeSettings } = require('./config');

const TTL_MS = 60_000;

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// ------------------------------------------------------------ key discovery

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

function resolveKey(envName, configName) {
  if (process.env[envName]) return process.env[envName];
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return fromDsh;
  const config = readConfig();
  return typeof config[configName] === 'string' && config[configName] ? config[configName] : null;
}

// --------------------------------------------------------------- http helper

async function getJson(url, key, extraHeaders) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': 'side-dock', ...extraHeaders },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function usageWindow(key, label, raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    key,
    label,
    status: typeof raw.status === 'string' ? raw.status : 'ok',
    percent: clampPercent(raw.percent),
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
  };
}

// ----------------------------------------------------------------- registry

/**
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} name
 * @property {'balance'|'quota'} kind
 * @property {string} accent   identity colour for the dot / bar
 * @property {string|null} logo  Simple Icons symbol id, when the renderer has one
 * @property {string} envKey
 * @property {string} configKey
 * @property {string} note     where the number comes from (shown in settings)
 */

/** @type {Provider[]} */
const REGISTRY = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'balance',
    accent: '#4d6bfe',
    logo: 'deepseek',
    envKey: 'DEEPSEEK_API_KEY',
    configKey: 'deepseekApiKey',
    note: '余额 · api.deepseek.com',
    async load(key) {
      const body = await getJson('https://api.deepseek.com/user/balance', key);
      const infos = Array.isArray(body && body.balance_infos) ? body.balance_infos : [];
      if (infos.length === 0) throw new Error('响应缺少 balance_infos');
      const primary = infos.find((wallet) => wallet && wallet.currency === 'CNY') || infos[0];
      return {
        status: body.is_available === false ? 'warning' : 'ok',
        balance: {
          currency: (primary && primary.currency) || 'CNY',
          total: safeNumber(primary && primary.total_balance),
          toppedUp: safeNumber(primary && primary.topped_up_balance),
          granted: safeNumber(primary && primary.granted_balance),
        },
      };
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode Go',
    kind: 'quota',
    accent: '#e6e9ef',
    logo: 'opencode',
    envKey: 'OPENCODE_GO_API_KEY',
    configKey: 'opencodeApiKey',
    note: '额度 · opencode.ai/zen/go',
    async load(key) {
      const body = await getJson('https://opencode.ai/zen/go/v1/usage', key);
      const usage = body && body.usage;
      if (!usage || typeof usage !== 'object') throw new Error('响应缺少 usage');
      return {
        status: 'ok',
        windows: [
          usageWindow('rolling', '5 小时', usage.rolling),
          usageWindow('weekly', '周', usage.weekly),
          usageWindow('monthly', '月', usage.monthly),
        ].filter(Boolean),
      };
    },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'balance',
    accent: '#8b5cf6',
    logo: null,
    envKey: 'OPENROUTER_API_KEY',
    configKey: 'openrouterApiKey',
    note: '余额 · 需 Management Key',
    async load(key) {
      const body = await getJson('https://openrouter.ai/api/v1/credits', key);
      const data = body && body.data;
      if (!data) throw new Error('响应缺少 data');
      const purchased = safeNumber(data.total_credits);
      const used = safeNumber(data.total_usage);
      return {
        status: 'ok',
        balance: { currency: 'USD', total: Math.round((purchased - used) * 100) / 100, toppedUp: purchased, granted: 0, spent: used },
      };
    },
  },
  {
    id: 'kimi',
    name: 'Kimi / Moonshot',
    kind: 'balance',
    accent: '#f5b544',
    logo: null,
    envKey: 'MOONSHOT_API_KEY',
    configKey: 'moonshotApiKey',
    note: '余额 · api.moonshot.cn',
    async load(key) {
      const body = await getJson('https://api.moonshot.cn/v1/users/me/balance', key);
      const data = body && body.data;
      if (!data) throw new Error((body && body.error && body.error.message) || '响应缺少 data');
      return {
        status: 'ok',
        balance: {
          currency: 'CNY',
          total: safeNumber(data.available_balance),
          toppedUp: safeNumber(data.cash_balance),
          granted: safeNumber(data.voucher_balance),
        },
      };
    },
  },
];

const IDS = REGISTRY.map((provider) => provider.id);
const state = new Map();

function entryFor(id) {
  if (!state.has(id)) state.set(id, { value: null, at: 0, pending: null, error: null });
  return state.get(id);
}

async function refresh(provider, key) {
  const entry = entryFor(provider.id);
  if (entry.pending) return entry.pending;
  entry.pending = (async () => {
    try {
      entry.value = await provider.load(key);
      entry.at = Date.now();
      entry.error = null;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    } finally {
      entry.pending = null;
    }
  })();
  return entry.pending;
}

function startIfStale(provider, key) {
  const entry = entryFor(provider.id);
  const stale = !entry.value || Date.now() - entry.at > TTL_MS;
  if (stale && !entry.pending) void refresh(provider, key);
  return entry.pending;
}

/**
 * Provider snapshot + the settings that say which of them to show.
 * @param {{awaitInitial?: boolean}} options
 */
async function collectProviders(options = {}) {
  const keys = new Map();
  const waits = [];
  for (const provider of REGISTRY) {
    const key = resolveKey(provider.envKey, provider.configKey);
    keys.set(provider.id, key);
    if (key) waits.push(startIfStale(provider, key));
  }
  if (options.awaitInitial && waits.length) await Promise.all(waits);

  const settings = normalizeSettings(readConfig(), IDS);
  const providers = REGISTRY.map((provider) => {
    const entry = entryFor(provider.id);
    const configured = Boolean(keys.get(provider.id));
    let status = 'loading';
    if (!configured) status = 'no-key';
    else if (entry.value) status = entry.value.status || 'ok';
    else if (entry.error) status = 'error';
    const base = {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      accent: provider.accent,
      logo: provider.logo,
      note: provider.note,
      envKey: provider.envKey,
      configKey: provider.configKey,
      configured,
      status,
      enabled: settings.providers.includes(provider.id),
      at: entry.at || null,
      error: configured ? entry.error || null : null,
    };
    if (provider.kind === 'balance') return { ...base, balance: entry.value ? entry.value.balance : null };
    return { ...base, windows: entry.value ? entry.value.windows : [] };
  });

  return { providers, settings };
}

module.exports = { collectProviders, REGISTRY_IDS: IDS };
