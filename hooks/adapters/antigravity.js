'use strict';
// Adaptador do Google Antigravity 2.0: payload do PreToolUse ⇄ tentativa normalizada.
//
// O contrato oficial usa camelCase no envelope (`toolCall.name` / `.args`),
// PascalCase nos argumentos das tools e exige uma decisão até para liberar.
// Não há como reescrever o resultado no PostToolUse, então este adaptador
// fecha leitura, shell, escrita e exfiltração antes da tool rodar.

const path = require('path');
const { classifyPath } = require('../../src/lib/targets');

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

    // grep_search devolve as linhas encontradas, portanto pesquisar dentro de
    // um arquivo-cofre é leitura do mesmo jeito que view_file.
    case 'grep_search':
      return classifyPath(ti.SearchPath || '').secret
        ? { ...base, kind: 'read', path: abs(ti.SearchPath) }
        : { ...base, kind: 'other' };

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
