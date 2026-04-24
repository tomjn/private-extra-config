#!/usr/bin/env node
/**
 * PreToolUse hook for Bash.
 *
 * Purpose: block `git push` with arguments (destructive force-push etc.)
 * while allowing the two safe forms: bare `git push` and the exact
 * `git push origin main`.
 *
 * Bypass closure (matches guard-bash-substitutes semantics):
 *   - Path prefix:       `/usr/bin/git push -f`       → blocked
 *   - Quotes:            `"git" push -f`              → blocked
 *   - Backslash-escape:  `\git push -f`               → blocked
 *   - Launcher wrappers: `command|exec|builtin|env git push -f` → blocked
 *   - Pipelines:         `something && git push -f`   → blocked
 *   - Pipe upstream:     `git push -f | tee log`      → blocked
 *
 * NOT closed (known limitation, matches guard-bash-substitutes):
 *   - `sudo git push -f`, `nice git push -f`, `time git push -f` — these
 *     wrappers have flag/arg semantics that would create false positives if
 *     unwrapped naively. sudo would also prompt for a password
 *     non-interactively, so it is not a practical bypass in this context.
 *
 * Escape hatch:
 *   - `# git-push-guard: allow` appended to the command force-allows it.
 *     Use when you need a one-off push form that the rule does not cover.
 *
 * Failure mode:
 *   - Multi-line / heredoc commands fail open (not parsed).
 *   - Any JSON parse error fails open.
 */

const fs = require('fs');
const {
  commandTokens,
  splitTopLevel,
  upstreamOfPipe,
  isMultilineOrHeredoc,
} = require('./lib/bash-parse');

function allow() {
  process.exit(0);
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function isForbiddenPush(segment) {
  const upstream = upstreamOfPipe(segment);
  if (!upstream) return false;
  const tokens = commandTokens(upstream);
  if (tokens[0] !== 'git') return false;
  if (tokens[1] !== 'push') return false;
  // Bare `git push` (no args) allowed.
  if (tokens.length === 2) return false;
  // Exactly `git push origin main` allowed.
  if (tokens.length === 4 && tokens[2] === 'origin' && tokens[3] === 'main') return false;
  return true;
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return allow();
  }

  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!cmd.trim()) return allow();
  if (isMultilineOrHeredoc(cmd)) return allow();
  if (/#\s*git-push-guard:\s*allow\b/.test(cmd)) return allow();

  const segments = splitTopLevel(cmd);
  for (const seg of segments) {
    if (isForbiddenPush(seg)) {
      return block(
        'guard-git-push: git push with arguments is blocked. ' +
          'Allowed forms: bare "git push" or exactly "git push origin main". ' +
          'All common bypass forms are also blocked: absolute paths (/usr/bin/git), ' +
          'quoted ("git"), backslash-escape (\\git), launcher wrappers ' +
          '(command/exec/builtin/env git), and chained/piped forms (foo && git push -f). ' +
          'Do not retry variants. Run manually with "! git push <args>", ' +
          'or append "# git-push-guard: allow" to the command if you need a one-off exception.',
      );
    }
  }
  allow();
}

main();
