#!/usr/bin/env node
/**
 * PreToolUse hook for Bash.
 *
 * Purpose: block `git push` with arguments (destructive force-push etc.)
 * while allowing the two safe forms: bare `git push` and the exact
 * `git push origin main`.
 *
 * Bypass closure (matches guard-bash-substitutes semantics):
 *   - Path prefix:       `/usr/bin/git push -f`         → blocked
 *   - Quotes:            `"git" push -f`                → blocked
 *   - Backslash-escape:  `\git push -f`                 → blocked
 *   - Launcher wrappers: `command|exec|builtin|env|eval git push -f` → blocked
 *   - rtk wrappers:      `rtk git push -f`              → blocked
 *   - rtk passthrough:   `rtk proxy|run|err|test|summary git push -f` → blocked
 *   - rtk shell:         `rtk bash -c "git push -f"`    → blocked
 *   - Shell runners:     `bash -c "..."` / `sh -c "..."` → blocked
 *   - Pipelines:         `something && git push -f`     → blocked
 *   - Pipe upstream:     `git push -f | tee log`        → blocked
 *
 * NOT closed (known limitations):
 *   - `sudo git push -f`, `nice git push -f`, `time git push -f` — these
 *     wrappers have flag/arg semantics that would create false positives if
 *     unwrapped naively. sudo would also prompt for a password
 *     non-interactively, so it is not a practical bypass in this context.
 *   - `bash -c 'git push -f && echo done'` — payloads with `;`/`&&`/`||`
 *     get split before unwrapping, so the `git push` may end up in a
 *     separate segment. In practice the inner segment usually still triggers
 *     the rule (`git push -f && echo done` splits to `git push -f`), but
 *     contrived payloads can evade. Quote-aware shell parsing is out of scope.
 *   - `bash -lc "..."` / `sh +c "..."` and other non-`-c` flag forms.
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
          '(command/exec/builtin/env/eval git), rtk wrappers (rtk git, rtk proxy|run|err|test|summary git, rtk bash -c "git ..."), ' +
          'shell runners (bash -c / sh -c "git ..."), and chained/piped forms (foo && git push -f). ' +
          'Do not retry variants. Run manually with "! git push <args>", ' +
          'or append "# git-push-guard: allow" to the command if you need a one-off exception.',
      );
    }
  }
  allow();
}

main();
