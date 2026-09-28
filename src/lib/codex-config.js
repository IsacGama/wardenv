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
    parts.push(String(part));
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

function maskMultilineStrings(source) {
  const text = String(source || '');
  let out = '';
  let delimiter = null;
  for (let i = 0; i < text.length; i++) {
    const triple = text.slice(i, i + 3);
    if (!delimiter && (triple === '"""' || triple === "'''")) {
      delimiter = triple;
      out += '   ';
      i += 2;
    } else if (delimiter && triple === delimiter) {
      delimiter = null;
      out += '   ';
      i += 2;
    } else if (delimiter) {
      out += text[i] === '\n' ? '\n' : ' ';
    } else {
      out += text[i];
    }
  }
  return out;
}

function parseStringValue(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return null; }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return null;
}

function splitInlineItems(value) {
  const text = value.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  const body = text.slice(1, -1);
  const items = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote === '"') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  items.push(body.slice(start));
  return items;
}

function codexConfigProblem(text) {
  let section = [];
  const settings = new Map();
  let activeProfile = null;
  const source = maskMultilineStrings(String(text || '').replace(/^\uFEFF/, ''));
  for (const raw of source.split(/\r?\n/)) {
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
    if (!key) continue;
    const fullPath = [...section, ...key];
    const full = fullPath.join('.');
    const value = setting[1].trim();

    if (full === 'profile') activeProfile = parseStringValue(value);
    if (/^(true|false)$/.test(value)) settings.set(full, value === 'true');

    const inline = splitInlineItems(value);
    if (inline) {
      for (const item of inline) {
        const pair = splitAssignment(item);
        const innerKey = pair && parseKeyPath(pair[0]);
        const innerValue = pair && pair[1].trim();
        if (innerKey && /^(true|false)$/.test(innerValue)) {
          settings.set([...fullPath, ...innerKey].join('.'), innerValue === 'true');
        }
      }
    }
  }

  if (settings.get('features.hooks') === false || settings.get('features.codex_hooks') === false) {
    return 'disables Codex hooks in config.toml';
  }
  if (settings.get('allow_managed_hooks_only') === true) {
    return 'allows only managed Codex hooks, skipping wardenv';
  }
  if (activeProfile) {
    const prefix = `profiles.${activeProfile}.features`;
    if (settings.get(`${prefix}.hooks`) === false || settings.get(`${prefix}.codex_hooks`) === false) {
      return `active Codex profile ${activeProfile} disables hooks`;
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
