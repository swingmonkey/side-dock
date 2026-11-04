'use strict';
/**
 * Local settings for Side Dock, stored next to the API keys:
 *   ~/.side-dock/config.json
 *
 * Shape:
 *   {
 *     "deepseekApiKey": "...", "opencodeApiKey": "...",   // keys live here too
 *     "providers": ["deepseek", "opencode"],              // enabled + display order
 *     "items": { "tokens": true, "rate": true, "system": true }
 *   }
 *
 * Writes merge into the existing file so keys are never clobbered.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_ITEMS = { tokens: true, rate: true, system: true };
const DEFAULT_PROVIDERS = ['deepseek', 'opencode'];

function configDir() {
  return path.join(os.homedir(), '.side-dock');
}

function configFile() {
  return path.join(configDir(), 'config.json');
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Settings as the UI needs them, always complete and validated.
 * @param {object} config
 * @param {string[]} knownIds provider ids the registry knows about
 */
function normalizeSettings(config, knownIds) {
  const known = Array.isArray(knownIds) ? knownIds : [];
  const raw = Array.isArray(config.providers) ? config.providers : null;
  const base = raw || DEFAULT_PROVIDERS;
  const providers = [];
  for (const id of base) {
    if (typeof id !== 'string') continue;
    if (known.length && !known.includes(id)) continue;
    if (providers.includes(id)) continue;
    providers.push(id);
  }
  const items = { ...DEFAULT_ITEMS };
  if (config.items && typeof config.items === 'object') {
    for (const key of Object.keys(DEFAULT_ITEMS)) {
      if (typeof config.items[key] === 'boolean') items[key] = config.items[key];
    }
  }
  return { providers, items };
}

/**
 * Persist a settings patch (providers and/or items) and return the saved file.
 * @param {{providers?: string[], items?: object}} patch
 * @param {string[]} knownIds
 */
function writeSettings(patch, knownIds) {
  const current = readConfig();
  const next = { ...current };
  if (patch && Array.isArray(patch.providers)) next.providers = patch.providers;
  if (patch && patch.items && typeof patch.items === 'object') {
    next.items = { ...(current.items && typeof current.items === 'object' ? current.items : {}) };
    for (const key of Object.keys(DEFAULT_ITEMS)) {
      if (typeof patch.items[key] === 'boolean') next.items[key] = patch.items[key];
    }
  }
  const settings = normalizeSettings(next, knownIds);
  next.providers = settings.providers;
  next.items = settings.items;
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(configFile(), 0o600);
  } catch {
    /* best effort */
  }
  return settings;
}

module.exports = { DEFAULT_ITEMS, DEFAULT_PROVIDERS, configFile, readConfig, normalizeSettings, writeSettings };
