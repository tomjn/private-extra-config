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

// Transparent command-launcher wrappers: `command`, `exec`, `builtin`, `env`
// all replace themselves with their first non-flag arg. `rtk` is included
// because it proxies the command after it (`rtk grep foo` runs grep through
// the rtk token-saver; semantically equivalent to `grep foo` for our
// bypass-closure purposes). Unwrapping these closes common bypasses like
// `command grep`, `\grep`, `env FOO=1 grep`, `rtk grep`.
const LAUNCHER = /^(command|exec|builtin|env|rtk)$/;
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
  // Advance past leading env assignments and launcher wrappers (composable).
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN.test(tokens[i])) i++;
  while (i < tokens.length && LAUNCHER.test(normalize(tokens[i]))) {
    i++;
    while (i < tokens.length && ENV_ASSIGN.test(tokens[i])) i++;
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
