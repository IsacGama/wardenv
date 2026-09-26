'use strict';
// Adaptador do Google Antigravity 2.0: payload do PreToolUse ⇄ tentativa normalizada.
//
// O contrato oficial usa camelCase no envelope (`toolCall.name` / `.args`),
// PascalCase nos argumentos das tools e exige uma decisão até para liberar.
// Não há como reescrever o resultado no PostToolUse, então este adaptador
// fecha leitura, shell, escrita e exfiltração antes da tool rodar.

const fs = require('fs');
const path = require('path');
const { classifyPath } = require('../../src/lib/targets');

const GREP_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv',
]);
const MAX_GREP_DIRS = 512;

function globRegExp(glob) {
  let source = '';
  const value = String(glob || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');

  // Unknown glob constructs stay conservative: an include we cannot model
  // must not be used to declare a vault file unreachable.
  if (/[\[\]{}()!]/.test(value)) return null;

  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '*' && value[i + 1] === '*') {
      if (value[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.*+?^${}|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

function included(file, root, includes) {
  if (includes == null || (Array.isArray(includes) && includes.length === 0)) return true;
  const patterns = Array.isArray(includes) ? includes : [includes];
  const relative = path.relative(root, file).replace(/\\/g, '/');
  const base = path.basename(file);
  // ripgrep applies globs in order, with the last matching rule winning.
  // With at least one positive glob, files start excluded; a negative-only
  // list starts included and merely subtracts matches.
  const hasPositive = patterns.some((pattern) => typeof pattern === 'string' && !pattern.startsWith('!'));
  let selected = !hasPositive;

  for (const raw of patterns) {
    if (typeof raw !== 'string') return true;
    const negative = raw.startsWith('!');
    const pattern = (negative ? raw.slice(1) : raw).replace(/\\/g, '/');
    const re = globRegExp(pattern);
    // Unsupported positive globs might include the file; unsupported negative
    // globs cannot safely prove that the tool excludes it.
    if (!re) {
      if (!negative) selected = true;
      continue;
    }
    const matches = re.test(pattern.includes('/') ? relative : base);
    if (matches) selected = !negative;
  }
  return selected;
}

function queryMatches(file, query, isRegex, caseInsensitive) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  // If a future Antigravity payload changes the query type, fail closed for
  // an otherwise reachable vault file without ever echoing the query/value.
  if (typeof query !== 'string') return true;
  let matcher;
  try {
    matcher = isRegex
      ? new RegExp(query, caseInsensitive ? 'i' : '')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseInsensitive ? 'i' : '');
  } catch {
    // Antigravity uses ripgrep's regex engine, not JavaScript's. A pattern JS
    // rejects may still be valid there, so do not turn that mismatch into a
    // bypass for an otherwise reachable vault file.
    return true;
  }

  return raw.split(/\r?\n/).some((line) => matcher.test(line));
}

function vaultFiles(searchPath, includes) {
  let stat;
  try {
    stat = fs.statSync(searchPath);
  } catch {
    return { files: [], complete: true };
  }

  if (stat.isFile()) {
    // Antigravity documents Includes as a directory-only filter.
    return { files: classifyPath(searchPath).secret ? [searchPath] : [], complete: true };
  }
  if (!stat.isDirectory()) return { files: [], complete: true };

  const found = [];
  const pending = [searchPath];
  let visited = 0;
  while (pending.length && visited < MAX_GREP_DIRS) {
    const dir = pending.shift();
    visited++;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !GREP_SKIP_DIRS.has(entry.name.toLowerCase())) pending.push(file);
      else if (entry.isFile() && classifyPath(file).secret && included(file, searchPath, includes)) found.push(file);
    }
  }
  return { files: found, complete: pending.length === 0 };
}

function normalizeGrep(base, ti, abs) {
  // With MatchPerLine=false Antigravity returns filenames, never matching
  // lines. The path itself is not secret content, so no read is exposed.
  if (ti.MatchPerLine === false) return { ...base, kind: 'other' };

  const searchPaths = Array.isArray(ti.SearchPath) ? ti.SearchPath : [ti.SearchPath];
  const matches = [];
  let incompleteTarget = null;

  for (const requested of searchPaths) {
    const target = abs(requested);
    const reachable = vaultFiles(target, ti.Includes);
    if (!reachable.complete) incompleteTarget = incompleteTarget || target;
    for (const file of reachable.files) {
      if (queryMatches(file, ti.Query, ti.IsRegex === true, ti.CaseInsensitive === true)) matches.push(file);
    }
  }

  const unique = [...new Set(matches)];
  if (unique.length) return unique.map((file) => ({ ...base, kind: 'read', path: file }));
  // A busca real alcançaria mais arquivos do que o hook conseguiu avaliar
  // dentro do limite. Negar é mais seguro que declarar essa área limpa.
  if (incompleteTarget) return { ...base, kind: 'read', path: path.join(incompleteTarget, '.env') };
  return { ...base, kind: 'other' };
}

function normalize(data) {
  const call = data.toolCall || {};
  const ti = call.args || {};
  const roots = Array.isArray(data.workspacePaths) ? data.workspacePaths : [];
  const cwd = ti.Cwd || roots[0] || process.cwd();
  const abs = (p) => (p ? path.resolve(cwd, String(p)) : '');
  const base = { tool: call.name || '', cwd, agent: 'principal' };

  switch (base.tool) {
    case 'view_file':
      return { ...base, kind: 'read', path: abs(ti.AbsolutePath) };

    // grep_search devolve as linhas encontradas. Uma busca em diretório pode
    // alcançar .env e outros cofres; só negamos quando filtros + consulta
    // realmente podem devolver uma linha deles, mantendo o uso normal leve.
    case 'grep_search':
      return normalizeGrep(base, ti, abs);

    case 'run_command':
      return { ...base, kind: 'shell', command: ti.CommandLine || '' };

    case 'write_to_file':
      return { ...base, kind: 'write', path: abs(ti.TargetFile), body: ti.CodeContent || '', edits: null };

    case 'replace_file_content':
      return {
        ...base,
        kind: 'write',
        path: abs(ti.TargetFile),
        body: ti.ReplacementContent || '',
        edits: [{ old: ti.TargetContent, new: ti.ReplacementContent, all: !!ti.AllowMultiple }],
      };

    case 'multi_replace_file_content': {
      const chunks = Array.isArray(ti.ReplacementChunks) ? ti.ReplacementChunks : [];
      return {
        ...base,
        kind: 'write',
        path: abs(ti.TargetFile),
        body: chunks.map((c) => c && c.ReplacementContent).filter((s) => typeof s === 'string').join('\n'),
        edits: chunks.map((c) => ({
          old: c && c.TargetContent,
          new: c && c.ReplacementContent,
          all: !!(c && c.AllowMultiple),
        })),
      };
    }

    default:
      return { ...base, kind: 'other' };
  }
}

function render(result) {
  if (result.action !== 'deny') return JSON.stringify({ decision: 'allow' });
  return JSON.stringify({
    decision: 'deny',
    reason: result.context ? `${result.reason}\n\n${result.context}` : result.reason,
  });
}

module.exports = { normalize, render };
