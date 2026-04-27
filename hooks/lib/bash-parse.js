/**
 * Shared bash-command parsing helpers for PreToolUse hooks.
 *
 * The hooks are narrow regex-based guards, not real shell parsers. These
 * helpers centralize the small amount of tokenization, unwrapping, and
 * segment-splitting they need so that bypass-closure work happens in one
 * place.
 *
 * Limitations (shared across consumers):
 *   - No quoting awareness: a literal `;`/`&&`/`||` inside a quoted arg will
 *     over-split. Acceptable — consumers only flag matches.
 *   - No full POSIX expansion: backticks, $( ), $VAR, glob expansion are not
 *     interpreted. A determined bypass via `$(echo grep) ...` is out of scope.
 *   - `sudo`/`nice`/`time` are NOT unwrapped. Their flag/arg semantics vary
 *     and would create false positives. Document this limitation in block
 *     reasons rather than trying to parse it.
 */

// Transparent command-launcher wrappers: `command`, `exec`, `builtin`, `env`,
// `eval` all replace themselves with their first non-flag arg. `rtk` is
// included because it proxies the command after it (`rtk grep foo` runs grep
// through the rtk token-saver; semantically equivalent to `grep foo`).
// Unwrapping these closes common bypasses like `command grep`, `\grep`,
// `env FOO=1 grep`, `rtk grep`, `eval "grep foo"`.
const LAUNCHER = /^(command|exec|builtin|env|eval|rtk)$/;

// rtk subcommands that take an arbitrary command and run it (versus tool-
// specific wrappers like `rtk grep` where the next token IS the command).
// `proxy`/`run` are documented bypass paths (`run` even uses `sh -c`).
// `err`/`test`/`summary` run [COMMAND]... per `rtk <sub> --help`.
// `bash`/`sh` are not real rtk subcommands — rtk falls through to the system
// binary, so `rtk bash -c '...'` is identical to `bash -c '...'`.
const RTK_PASSTHROUGH = /^(proxy|run|err|test|summary|bash|sh)$/;

// Shell binaries that take a `-c <string>` shell payload. We naive-tokenize
// the payload (whitespace-split, edge-quote-strip), which is enough to catch
// the common `bash -c "git push -f"` form. Payloads containing `;`/`&&`
// over-split at splitTopLevel time, which still tends to surface the inner
// command in one of the resulting segments — a partial closure, not perfect.
const SHELL_RUNNER = /^(bash|sh)$/;

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function normalize(token) {
  // Strip surrounding quotes, leading backslash-escape, and any path prefix so
  // `"/usr/bin/grep"`, `\grep`, and `/bin/grep` all canonicalize to `grep`.
  return token
    .replace(/^["']+|["']+$/g, '')
    .replace(/^\\/, '')
    .split('/')
    .pop();
}

function tokenize(segment) {
  return segment.trim().split(/\s+/);
}

function stripPrefix(tokens) {
  // Advance past leading env assignments, launcher wrappers, rtk passthrough
  // subcommands, and shell `-c` runners. Composable: the loop continues until
  // no rule fires, so chains like `env FOO=1 rtk proxy bash -c "..."` unwrap
  // fully.
  let i = 0;
  let advanced = true;
  while (advanced && i < tokens.length) {
    advanced = false;

    // Env assignments first (FOO=bar, BAR=baz before a launcher).
    while (i < tokens.length && ENV_ASSIGN.test(tokens[i])) {
      i++;
      advanced = true;
    }
    if (i >= tokens.length) break;

    const cur = normalize(tokens[i]);
    const next = i + 1 < tokens.length ? normalize(tokens[i + 1]) : null;
    const after = i + 2 < tokens.length ? normalize(tokens[i + 2]) : null;

    // `bash -c <payload>` / `sh -c <payload>` — strip the runner+flag and
    // treat the payload tokens as the real command.
    if (SHELL_RUNNER.test(cur) && next === '-c') {
      i += 2;
      advanced = true;
      continue;
    }

    // Launcher word (command|exec|builtin|env|eval|rtk).
    if (LAUNCHER.test(cur)) {
      // `rtk bash -c ...` / `rtk sh -c ...` — eat all three.
      if (cur === 'rtk' && next && SHELL_RUNNER.test(next) && after === '-c') {
        i += 3;
        advanced = true;
        continue;
      }
      // `rtk <passthrough> <cmd>...` — eat rtk and the subcommand.
      // (For `bash`/`sh` without `-c`, this also fires — fine; the next token
      // is treated as the real command, matching how rtk falls through.)
      if (cur === 'rtk' && next && RTK_PASSTHROUGH.test(next)) {
        i += 2;
        advanced = true;
        continue;
      }
      // Plain single-word launcher.
      i++;
      advanced = true;
      continue;
    }
  }
  return i;
}

function firstCommandWord(segment) {
  const tokens = tokenize(segment);
  const i = stripPrefix(tokens);
  if (i >= tokens.length) return '';
  return normalize(tokens[i]);
}

function commandTokens(segment) {
  // Return [cmd, ...args], all normalized. Normalizing args (stripping quotes,
  // path prefix) means `git "push" "origin" "main"` still matches an allow-list
  // of `[git, push, origin, main]`.
  const tokens = tokenize(segment);
  const i = stripPrefix(tokens);
  if (i >= tokens.length) return [];
  return tokens.slice(i).map(normalize);
}

function splitTopLevel(cmd) {
  // Split on top-level compound operators. Does not track quoting (see header).
  return cmd.split(/(?:&&|\|\||;)/).map((s) => s.trim()).filter(Boolean);
}

function upstreamOfPipe(segment) {
  // First pipe component: `a | b | c` -> `a`. `||` is not a pipe.
  return segment.split(/\|(?!\|)/)[0].trim();
}

function isMultilineOrHeredoc(cmd) {
  return cmd.includes('\n') || cmd.includes('<<');
}

module.exports = {
  LAUNCHER,
  RTK_PASSTHROUGH,
  SHELL_RUNNER,
  ENV_ASSIGN,
  normalize,
  tokenize,
  stripPrefix,
  firstCommandWord,
  commandTokens,
  splitTopLevel,
  upstreamOfPipe,
  isMultilineOrHeredoc,
};
