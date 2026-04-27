#!/usr/bin/env node
/**
 * PreToolUse hook for Bash.
 *
 * Purpose: nudge the assistant away from bash invocations that duplicate a
 * dedicated Claude tool, which wastes output tokens (the tool call content
 * becomes cache-read on every subsequent turn).
 *
 * Rules (narrow on purpose — false positives are worse than false negatives):
 *   - `grep|rg|egrep|fgrep ...`    → Grep tool
 *   - `cat|head|tail <file>`       → Read tool
 *   - `find <path> -name <pat>`    → Glob tool (only when no other predicate
 *     like -mtime/-type/-size/-perm is present)
 *
 * Not blocked (too many legitimate pipeline uses or false positives):
 *   - ls, sed, awk, echo, printf, sort, uniq, wc, etc.
 *
 * Exceptions:
 *   - Pipe downstream commands (e.g. `foo | grep bar`) are allowed — grep
 *     after a pipe is processing dynamic output from another command.
 *   - Multi-line commands and heredocs fail open (too risky to parse).
 *   - Commands containing `# bash-guard: allow` are always allowed.
 *   - Any parse error or unexpected input fails open.
 *
 * Hook protocol: read PreToolUse JSON from stdin; emit
 * `{"decision":"block","reason":"..."}` on stdout to block, or exit silently
 * to allow.
 */

const fs = require('fs');
const {
  firstCommandWord,
  splitTopLevel,
  upstreamOfPipe,
  isMultilineOrHeredoc,
} = require('./lib/bash-parse');

const CONTENT_SEARCH = /^(grep|rg|egrep|fgrep)$/;
const FILE_READ = /^(cat|head|tail)$/;
const FIND_SIMPLE_NAME = /\s-name\s+/;
const FIND_OTHER_PREDICATE = /\s-(mtime|ctime|atime|mmin|amin|cmin|size|perm|type|newer|regex|iregex|prune|path|ipath|empty|user|group|uid|gid)\b/;

function allow() {
  process.exit(0);
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function checkSegment(segment) {
  // For a pipeline, only check the UPSTREAM command.
  // `cat a | grep b` -> check `cat a`, not the downstream `grep b`.
  const firstPipePart = upstreamOfPipe(segment);
  if (!firstPipePart) return null;

  const word = firstCommandWord(firstPipePart);
  if (!word) return null;

  if (CONTENT_SEARCH.test(word)) {
    return {
      word,
      tool: 'Grep',
      hint: 'Use the Grep tool (built on ripgrep) for content search — it has the correct permissions and better defaults.',
    };
  }
  if (FILE_READ.test(word)) {
    return {
      word,
      tool: 'Read',
      hint: 'Use the Read tool (supports offset/limit for partial reads and renders images/PDFs).',
    };
  }
  if (word === 'find' && FIND_SIMPLE_NAME.test(firstPipePart) && !FIND_OTHER_PREDICATE.test(firstPipePart)) {
    return {
      word,
      tool: 'Glob',
      hint: 'Use the Glob tool for name-based file search (e.g. "**/*.ts").',
    };
  }
  return null;
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

  // Fail open on multi-line or heredoc commands — naive splitting would
  // misattribute and too-eagerly block.
  if (isMultilineOrHeredoc(cmd)) return allow();

  // Explicit escape hatch.
  if (/#\s*bash-guard:\s*allow\b/.test(cmd)) return allow();

  const segments = splitTopLevel(cmd);

  for (const seg of segments) {
    const violation = checkSegment(seg);
    if (violation) {
      return block(
        `guard-bash-substitutes: bash '${violation.word}' is blocked. ${violation.hint} ` +
          `(Use the ${violation.tool} tool instead.) ` +
          `All common workarounds are also blocked: absolute paths (/usr/bin/${violation.word}), ` +
          `quoted ("${violation.word}"), backslash-escape (\\${violation.word}), launcher wrappers ` +
          `(command/exec/builtin/env/eval ${violation.word}), rtk wrappers ` +
          `(rtk ${violation.word}, rtk proxy|run|err|test|summary ${violation.word}, rtk bash -c "${violation.word} ..."), ` +
          `and shell runners (bash -c / sh -c "${violation.word} ..."). ` +
          `Do not retry variants — switch to the ${violation.tool} tool. ` +
          `If you genuinely need the shell version, append "# bash-guard: allow" to the command.`,
      );
    }
  }

  allow();
}

main();
