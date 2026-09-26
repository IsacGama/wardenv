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

/** Parseia bare/quoted dotted keys do TOML sem interpretar valores gerais. */
function parseKeyPath(source) {
  const text = String(source || '');
  const parts = [];
  let i = 0;
  const space = () => { while (/\s/.test(text[i] || '')) i++; };

  while (i < text.length) {
    space();
    let part = '';
    if (text[i] === '"') {
      const start = i++;
      let escaped = false;
      while (i < text.length) {
        const ch = text[i++];
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') break;
      }
      if (text[i - 1] !== '"') return null;
      try {
        part = JSON.parse(text.slice(start, i));
      } catch {
        return null;
      }
    } else if (text[i] === "'") {
      const end = text.indexOf("'", ++i);
      if (end < 0) return null;
      part = text.slice(i, end);
      i = end + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!match) return null;
      part = match[0];
      i += match[0].length;
    }
    parts.push(String(part).toLowerCase());
    space();
    if (i === text.length) return parts;
    if (text[i] !== '.') return null;
    i++;
  }
  return parts.length ? parts : null;
}

function splitAssignment(line) {
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
    else if (ch === '=') return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
}

function codexConfigProblem(text) {
  let section = [];
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      section = parseKeyPath(header[1]) || [];
      continue;
    }
    const setting = splitAssignment(line);
    if (!setting) continue;
    const key = parseKeyPath(setting[0]);
    if (!key || !/^(true|false)$/i.test(setting[1].trim())) continue;
    const value = setting[1].trim().toLowerCase() === 'true';
    const full = [...section, ...key].join('.');

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
