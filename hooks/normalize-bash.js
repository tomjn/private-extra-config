#!/usr/bin/env node
/**
 * normalize-bash.js — PreToolUse hook for the Bash tool.
 *
 * Two jobs in one pass:
 *
 *   1. **Rewrite for execution.** Strip absolute paths and surrounding quotes
 *      from the command word in each segment of a compound/piped command, so
 *      `/bin/ls -la | "head" -n 3` → `ls -la | head -n 3`. Argument tokens are
 *      preserved verbatim (only the command word is normalized).
 *
 *   2. **Allowlist re-evaluation.** Split the rewritten command on top-level
 *      `&&`, `||`, `;`, `|`, then check each segment's normalized command word
 *      against the user's `permissions` allow / deny / ask rules read from
 *      `~/.claude/settings.json`, `$cwd/.claude/settings.json`, and
 *      `$cwd/.claude/settings.local.json`. If every non-builtin segment matches
 *      an `allow` rule and none match `deny` or `ask`, emit
 *      `permissionDecision: "allow"` so Claude Code skips the prompt.
 *      Otherwise emit only `updatedInput` (or nothing) and let the built-in
 *      matcher handle the prompt.
 *
 * Rewrite is *never* a blanket allow. The hook only auto-allows when the
 * user's own allowlist matches the rewritten command. The intent is "rewrite
 * so the existing allowlist matches", not "open the gate".
 *
 * Replaces:
 *   - normalize-abs-paths.js (rewrite-only, deleted)
 *   - the user's standalone check-compound-bash.ts (compound-only auto-allow)
 *
 * Out of scope (intentional):
 *   - `bash -c "<payload>"` rewriting: the payload is a quoted shell string;
 *     tokenization is too lossy. The existing guard-bash-substitutes hook
 *     covers the security-relevant cases. We let `bash`/`sh` segments fall
 *     through unmodified.
 *   - Multiline / heredoc commands: parse risk; fail open.
 *   - Args that themselves contain abs paths or quotes: only the command word
 *     is normalized — `cmd "/bin/ls is great"` keeps the literal arg.
 *
 * No escape hatch: unlike the sibling block-guards, this hook only rewrites
 * the command word and only auto-allows when the user's own allowlist already
 * matches the rewritten form — so there is nothing to override. Skipping
 * normalization when `# bash-guard: allow` is present caused absolute-path
 * commands to reach the permission system unrewritten and miss allowlist rules
 * keyed on the bare command name.
 *
 * Hook protocol: PreToolUse JSON on stdin; emit
 *   {hookSpecificOutput: {hookEventName: 'PreToolUse',
 *                          updatedInput?: {command: ...},
 *                          permissionDecision?: 'allow',
 *                          permissionDecisionReason?: ...}}
 * or exit silently to defer entirely.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalize,
  tokenize,
  stripPrefix,
  isMultilineOrHeredoc,
} = require('./lib/bash-parse');

// Shell builtins / control words that are always safe (no side effects beyond
// the session). A segment whose command word is a builtin is excluded from
// the allowlist check — it doesn't need a `Bash(cd:*)` rule to be allowed.
// Mirrors the user's prior check-compound-bash.ts list.
const SAFE_BUILTINS = new Set([
  'cd', 'export', 'set', 'unset', 'true', 'false', ':', 'shopt',
  'pushd', 'popd', 'dirs', 'hash', 'type',
  'local', 'declare', 'typeset', 'readonly', 'shift', 'return',
  'break', 'continue', 'if', 'then', 'else', 'elif', 'fi',
  'for', 'while', 'until', 'do', 'done', 'case', 'esac',
]);

// Top-level separators: &&, ||, ;, and pipe (but NOT ||). The capturing group
// preserves separators when split, so they can be re-joined unchanged.
const SEP_RE = /(&&|\|\||;|\|(?!\|))/;

function analyzeSegment(segment) {
  // Returns:
  //   effective:    "cmd args..." string used for prefix matching, '' if empty/builtin
  //   isBuiltin:    true if the command word is in SAFE_BUILTINS
  //   replacement:  {orig, cmdWord} when the command-word token differs after
  //                 normalization (abs path / quotes stripped); null otherwise.
  const trimmed = segment.replace(/^\s*\(?\s*/, '').replace(/\s*\)?\s*$/, '');
  if (!trimmed) return { effective: '', isBuiltin: false, replacement: null };
  const tokens = tokenize(trimmed);
  const i = stripPrefix(tokens);
  if (i >= tokens.length) return { effective: '', isBuiltin: false, replacement: null };
  const orig = tokens[i];
  const cmdWord = normalize(orig);
  if (SAFE_BUILTINS.has(cmdWord)) {
    return { effective: '', isBuiltin: true, replacement: null };
  }
  const effective = [cmdWord, ...tokens.slice(i + 1)].join(' ');
  const replacement = orig !== cmdWord ? { orig, cmdWord } : null;
  return { effective, isBuiltin: false, replacement };
}

function loadRules() {
  const home = os.homedir();
  const cwd = process.cwd();
  const paths = [
    path.join(home, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];
  const merged = { allow: [], deny: [], ask: [] };
  for (const p of paths) {
    let data;
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const perms = (data && data.permissions) || {};
    for (const key of ['allow', 'deny', 'ask']) {
      const rules = Array.isArray(perms[key]) ? perms[key] : [];
      for (const rule of rules) {
        const m = String(rule).match(/^Bash\((.+)\)$/);
        if (!m) continue;
        merged[key].push(m[1].replace(/:?\*$/, ''));
      }
    }
  }
  return merged;
}

function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const cmd = (input && input.tool_input && input.tool_input.command) || '';
  if (!cmd.trim()) process.exit(0);
  if (isMultilineOrHeredoc(cmd)) process.exit(0);

  const parts = cmd.split(SEP_RE);
  const effectives = [];
  const rewrittenParts = parts.map((part, idx) => {
    if (idx % 2 === 1) return part; // captured separator
    const a = analyzeSegment(part);
    if (a.isBuiltin) return part;
    if (a.effective) effectives.push(a.effective);
    if (a.replacement) {
      // Plain string .replace replaces only the FIRST occurrence — that's the
      // command-word token. Args identical to the cmd word are preserved.
      return part.replace(a.replacement.orig, a.replacement.cmdWord);
    }
    return part;
  });

  const rewritten = rewrittenParts.join('');
  const changed = rewritten !== cmd;

  const out = { hookEventName: 'PreToolUse' };
  if (changed) out.updatedInput = { command: rewritten };

  if (effectives.length > 0) {
    const rules = loadRules();
    const anyDeny = effectives.some((e) => rules.deny.some((p) => e.startsWith(p)));
    const anyAsk = effectives.some((e) => rules.ask.some((p) => e.startsWith(p)));
    const allAllow = effectives.every((e) => rules.allow.some((p) => e.startsWith(p)));
    if (!anyDeny && !anyAsk && allAllow) {
      out.permissionDecision = 'allow';
      out.permissionDecisionReason = 'normalize-bash: every segment matches an allowlisted Bash rule';
    }
  }

  if (!out.updatedInput && !out.permissionDecision) process.exit(0);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
  process.exit(0);
}

main();
