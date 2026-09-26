'use strict';
// Adaptador do Codex CLI (0.129+): payload do PreToolUse/PostToolUse ⇄ tentativa normalizada.
//
// O formato de resposta é o mesmo do Claude. O que muda é a entrada:
//   - todo shell chega como tool "Bash", inclusive PowerShell no Windows;
//   - escrita é "apply_patch", com o patch cru em tool_input.command. Um patch
//     pode mexer em vários arquivos, então vira uma tentativa por arquivo.
//   - MCPs e outras tools locais também disparam hooks. Como seus argumentos
//     variam, caminhos/valores/commands são extraídos conservadoramente.
//
// Codex trata deny sem reason como inválido e deixa passar, por isso o render
// nunca manda reason vazio.

const path = require('path');
const claude = require('./claude');
const { classifyPath } = require('../../src/lib/targets');

function base(data) {
  return {
    tool: data.tool_name || '',
    cwd: data.cwd || process.cwd(),
    agent: data.agent_id ? `subagente:${data.agent_type || '?'}` : 'principal',
  };
}

/**
 * Lê o formato de patch do Codex (`*** Begin Patch` … `*** End Patch`).
 * @returns {Array<{path:string, added:string[], hunks:Array<{old:string,new:string}>}>}
 */
function parsePatch(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  const flush = () => {
    if (cur && hunk && (hunk.old.length || hunk.new.length)) {
      cur.hunks.push({ old: hunk.old.join('\n'), new: hunk.new.join('\n') });
    }
    hunk = null;
  };

  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      flush();
      cur = { path: m[2].trim(), added: [], hunks: [] };
      files.push(cur);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && cur) {
      // O conteúdo vai para o destino; é ele que precisa ser checado.
      cur.path = mv[1].trim();
      continue;
    }
    if (!cur || line.startsWith('*** ')) continue;
    if (line.startsWith('@@')) {
      flush();
      continue;
    }
    hunk = hunk || { old: [], new: [] };
    if (line.startsWith('+')) {
      cur.added.push(line.slice(1));
      hunk.new.push(line.slice(1));
    } else if (line.startsWith('-')) {
      hunk.old.push(line.slice(1));
    } else {
      const ctx = line.startsWith(' ') ? line.slice(1) : line;
      hunk.old.push(ctx);
      hunk.new.push(ctx);
    }
  }
  flush();
  return files;
}

function stringLeaves(value, key = '', out = []) {
  if (typeof value === 'string') {
    out.push({ key, value });
  } else if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, key, out);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) stringLeaves(child, childKey, out);
  }
  return out;
}

function commandHead(command) {
  const raw = String(command || '').trim();
  const match = /^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(raw);
  const executable = match ? match[1] || match[2] || match[3] || '' : '';
  const bin = executable.toLowerCase().split('/').pop().split('\\').pop().replace(/\.(exe|cmd|bat|com)$/, '');
  return { bin, args: match ? raw.slice(match[0].length).trim() : '' };
}

/**
 * Uma sessão interativa permite que `write_stdin` execute texto que nunca
 * passa por outro PreToolUse. Bloqueamos apenas shells/REPLs sem programa,
 * `-c`, `-e`, `-m` ou arquivo explícito; comandos normais seguem livres.
 */
function isInteractiveSession(command) {
  const raw = String(command || '').trim();
  if (!raw) return false;
  const { bin, args } = commandHead(raw);
  const tokens = args ? args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [] : [];

  if (['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'pwsh', 'powershell'].includes(bin)) {
    // -v/-h são modos de shell em Bash/sh, não consultas de versão/ajuda.
    if (tokens.some((t) => /^(?:--help|--version)$/i.test(t))) return false;
    if ((bin === 'pwsh' || bin === 'powershell') && tokens.some((t) => /^-(?:v|version)$/i.test(t))) return true;
    if (tokens.some((t) => /^(?:-i|--interactive|-noexit)$/i.test(t))) return true;
    const commandAt = tokens.findIndex((t) => /^(?:-c|--command|-command|-file)$/i.test(t));
    if (commandAt >= 0) {
      const payload = (tokens[commandAt + 1] || '').replace(/^['"]|['"]$/g, '');
      return (bin === 'pwsh' || bin === 'powershell') && (!payload || payload === '-');
    }
    return tokens.every((t) => /^[-/]/.test(t));
  }
  if (bin === 'cmd') {
    if (tokens.some((t) => /^\/\?$/i.test(t))) return false;
    return !tokens.some((t) => /^\/[c]$/i.test(t));
  }
  if (['deno', 'bun'].includes(bin) && /^repl$/i.test(tokens[0] || '')) return true;
  if (bin === 'node' && tokens.some((t) => /^(?:--test|--check)$/i.test(t))) return false;
  if (bin === 'irb') return true;
  if (['node', 'deno', 'bun', 'python', 'python3', 'ruby', 'php'].includes(bin)) {
    if (tokens.some((t) => /^(?:-h|--help|-v|--version)$/i.test(t))) return false;
    if (tokens.some((t) => /^(?:-i|--interactive)$/i.test(t))) return true;
    if (bin === 'php' && tokens.some((t) => /^-a$/i.test(t))) return true;
    if (tokens.some((t) => /^(?:-c|-e|-m|-p|-r|--eval|--print)$/i.test(t))) return false;
    return tokens.every((t) => /^-/.test(t));
  }
  return false;
}

/** Tools locais/MCP não têm contrato comum: extrai sinais seguros. */
function normalizeOpaque(b, input) {
  const leaves = stringLeaves(input);
  const attempts = [];
  const pathTool = /(?:file|read|upload|attach|send|copy|move|resource)/i.test(b.tool);

  for (const leaf of leaves) {
    if (/^(command|commandline|cmd|script|shell_command)$/i.test(leaf.key)) {
      attempts.push({ ...b, kind: 'shell', command: leaf.value });
    }
    // A documentação diz que write_stdin não dispara PreToolUse hoje.
    // Se isso mudar, o texto enviado já cai na policy de comando.
    if (/write_stdin/i.test(b.tool) && /^(chars|input)$/i.test(leaf.key)) {
      attempts.push({ ...b, kind: 'shell', command: leaf.value });
    }
  }

  const paths = leaves
    .filter((leaf) => pathTool || /(?:path|file|filename|source|src|target|input|upload|attachment|resource|uri)/i.test(leaf.key))
    .map((leaf) => leaf.value.trim())
    .filter((value) => value && classifyPath(value).secret)
    .map((value) => path.resolve(b.cwd, value));

  attempts.push({ ...b, kind: 'opaque', paths: [...new Set(paths)], values: leaves.map((leaf) => leaf.value) });
  return attempts;
}

/** @returns {object|object[]} uma tentativa, ou uma por arquivo do patch */
function normalize(data) {
  const b = base(data);
  const ti = data.tool_input || {};

  if (b.tool === 'Bash') {
    const command = ti.command || '';
    if (ti.tty === true || ti.interactive === true || ti.run_persistent === true || ti.RunPersistent === true || isInteractiveSession(command)) {
      return { ...b, kind: 'interactive', command };
    }
    return { ...b, kind: 'shell', command };
  }

  if (b.tool === 'apply_patch' || b.tool === 'Edit' || b.tool === 'Write') {
    const files = parsePatch(ti.command || ti.patch || '');
    if (!files.length) return { ...b, kind: 'other' };
    return files.map((f) => ({
      ...b,
      kind: 'write',
      path: path.resolve(b.cwd, f.path),
      body: f.added.join('\n'),
      // Arquivo novo não tem "antes": o corpo é o arquivo inteiro.
      edits: f.hunks.length && f.hunks.some((h) => h.old) ? f.hunks.map((h) => ({ ...h, all: false })) : null,
    }));
  }

  return normalizeOpaque(b, ti);
}

function render(result) {
  if (result.action !== 'deny') return '';
  return claude.render({ ...result, reason: result.reason || 'wardenv: blocked.' });
}

// ---- PostToolUse -------------------------------------------------------

function normalizePost(data) {
  return { ...base(data), output: data.tool_response };
}

// Codex não tem campo para trocar o output. Um "block" com reason substitui
// o resultado que o modelo vê pelo reason; o comando já rodou.
function renderPost(clean, unique) {
  const text = typeof clean === 'string' ? clean : JSON.stringify(clean);
  return JSON.stringify({
    decision: 'block',
    reason:
      `wardenv redacted ${unique.length} secret(s) from this output: ${unique.join(', ')}. ` +
      'Values were replaced with «wardenv:NAME». Use the variable name in code; ' +
      'never try to recover the literal value. Redacted output follows.\n\n' + text,
  });
}

module.exports = { normalize, render, normalizePost, renderPost, parsePatch, isInteractiveSession, stringLeaves };
