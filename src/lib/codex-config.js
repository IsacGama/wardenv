'use strict';

// Flags do config.toml que fazem ~/.codex/hooks.json deixar de executar.
// Parser propositalmente pequeno: só interpreta booleanos nas chaves que
// importam, removendo comentários sem quebrar # dentro de strings.

const path = require('path');
const os = require('os');

const CODEX_CONFIG_RE = /[\\/]\.codex[\\/]config\.toml$/i;

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function codexConfigProblem(text) {
  let section = '';
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    const setting = /^([A-Za-z0-9_.-]+)\s*=\s*(true|false)\s*$/i.exec(line);
    if (!setting) continue;
    const key = setting[1].toLowerCase();
    const value = setting[2].toLowerCase() === 'true';
    const full = section ? `${section}.${key}` : key;

    if ((full === 'features.hooks' || full === 'features.codex_hooks') && !value) {
      return 'disables Codex hooks in config.toml';
    }
    if (full === 'allow_managed_hooks_only' && value) {
      return 'allows only managed Codex hooks, skipping wardenv';
    }
  }
  return null;
}

function isCodexConfig(filePath) {
  const file = path.resolve(String(filePath || ''));
  return CODEX_CONFIG_RE.test(file) || samePath(file, path.join(codexHome(), 'config.toml'));
}

function isCodexHooks(filePath) {
  return samePath(path.resolve(String(filePath || '')), path.join(codexHome(), 'hooks.json'));
}

function codexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

function samePath(a, b) {
  const normalize = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  return normalize(path.resolve(a)) === normalize(path.resolve(b));
}

module.exports = { codexConfigProblem, isCodexConfig, isCodexHooks, codexHome, CODEX_CONFIG_RE };
