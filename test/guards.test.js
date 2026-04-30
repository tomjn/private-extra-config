#!/usr/bin/env node
/**
 * Hook integration tests.
 *
 * Each case feeds a Bash PreToolUse JSON payload to a guard via stdin and
 * checks whether the guard emitted `{"decision":"block",...}` (block) or
 * exited silently (allow). No external test framework — keep deps zero so
 * `node test/guards.test.js` works on any machine that can run the hooks.
 *
 * Run from repo root:
 *   node test/guards.test.js
 *
 * Exit code is 0 on pass, 1 on any failure.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const HOOKS = path.resolve(__dirname, '..', 'hooks');
const GUARD_PUSH = path.join(HOOKS, 'guard-git-push.js');
const GUARD_BASH = path.join(HOOKS, 'guard-bash-substitutes.js');
const NORMALIZE = path.join(HOOKS, 'normalize-bash.js');

function run(hook, command) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const r = spawnSync('node', [hook], { input, encoding: 'utf8' });
  return { stdout: r.stdout || '', status: r.status };
}

function parseNormalize(stdout) {
  // normalize-bash emits {hookSpecificOutput: {...}} or nothing.
  if (!stdout.trim()) return { rewritten: null, allowed: false };
  try {
    const obj = JSON.parse(stdout);
    const out = obj.hookSpecificOutput || {};
    return {
      rewritten: out.updatedInput ? out.updatedInput.command : null,
      allowed: out.permissionDecision === 'allow',
    };
  } catch {
    return { rewritten: null, allowed: false };
  }
}

// [hook, command, expected: 'block' | 'allow', label]
const cases = [
  // ─── guard-git-push: rtk passthrough subcommands ──────────────────────
  [GUARD_PUSH, 'rtk proxy git push -X origin foo', 'block', 'rtk proxy passthrough'],
  [GUARD_PUSH, 'rtk run git push -X origin foo', 'block', 'rtk run passthrough'],
  [GUARD_PUSH, 'rtk err git push -X origin foo', 'block', 'rtk err passthrough'],
  [GUARD_PUSH, 'rtk summary git push origin feature', 'block', 'rtk summary passthrough'],
  [GUARD_PUSH, 'rtk test git push origin feature', 'block', 'rtk test passthrough'],

  // ─── guard-git-push: shell-runner -c payloads ─────────────────────────
  [GUARD_PUSH, 'bash -c "git push -X origin foo"', 'block', 'bash -c'],
  [GUARD_PUSH, 'sh -c "git push -X origin foo"', 'block', 'sh -c'],
  [GUARD_PUSH, 'rtk bash -c "git push -X origin foo"', 'block', 'rtk bash -c'],
  [GUARD_PUSH, 'rtk sh -c "git push origin feature"', 'block', 'rtk sh -c'],
  [GUARD_PUSH, 'eval "git push -X origin foo"', 'block', 'eval'],

  // ─── guard-git-push: composed wrappers ────────────────────────────────
  [GUARD_PUSH, 'env FOO=1 rtk proxy git push origin feature', 'block', 'env + rtk proxy'],
  [GUARD_PUSH, 'command rtk proxy git push origin feature', 'block', 'command + rtk proxy'],
  [GUARD_PUSH, '/usr/bin/git push -X origin foo', 'block', 'absolute-path git'],
  [GUARD_PUSH, '"git" push -X origin foo', 'block', 'quoted git'],
  [GUARD_PUSH, '\\git push -X origin foo', 'block', 'backslash-escape git'],
  [GUARD_PUSH, 'true && git push -X origin foo', 'block', '&& chain'],

  // ─── guard-git-push: legitimate forms must still pass ─────────────────
  [GUARD_PUSH, 'git push', 'allow', 'bare git push'],
  [GUARD_PUSH, 'git push origin main', 'allow', 'safe explicit form'],
  [GUARD_PUSH, 'rtk gain', 'allow', 'rtk meta subcommand'],
  [GUARD_PUSH, 'rtk discover', 'allow', 'rtk meta subcommand'],
  [GUARD_PUSH, 'rtk grep foo', 'allow', 'rtk tool wrapper (not git)'],
  [GUARD_PUSH, 'rtk proxy ls', 'allow', 'rtk proxy non-git command'],
  [GUARD_PUSH, 'bash -c "echo hello"', 'allow', 'bash -c non-git payload'],
  [GUARD_PUSH, 'rtk bash -c "echo hello"', 'allow', 'rtk bash -c non-git'],
  [GUARD_PUSH, 'rtk proxy git status', 'allow', 'rtk proxy + git non-push'],
  [GUARD_PUSH, 'git push -X origin foo # git-push-guard: allow', 'allow', 'escape hatch'],
  [GUARD_PUSH, 'echo "git push -f"', 'allow', 'string content not command'],

  // ─── guard-bash-substitutes: closures ─────────────────────────────────
  [GUARD_BASH, 'rtk proxy grep foo', 'block', 'rtk proxy grep'],
  [GUARD_BASH, 'rtk run grep foo', 'block', 'rtk run grep'],
  [GUARD_BASH, 'rtk bash -c "grep foo bar.txt"', 'block', 'rtk bash -c grep'],
  [GUARD_BASH, 'bash -c "grep foo bar.txt"', 'block', 'bash -c grep'],
  [GUARD_BASH, 'sh -c "cat /etc/hosts"', 'block', 'sh -c cat'],
  [GUARD_BASH, 'eval "grep foo bar.txt"', 'block', 'eval grep'],
  [GUARD_BASH, 'rtk err cat /etc/hosts', 'block', 'rtk err cat'],

  // ─── guard-bash-substitutes: legitimate forms ─────────────────────────
  [GUARD_BASH, 'ps aux | grep claude', 'allow', 'pipe downstream grep'],
  [GUARD_BASH, 'ls -la', 'allow', 'ls'],
  [GUARD_BASH, 'echo hello', 'allow', 'echo'],
  [GUARD_BASH, 'rtk gain', 'allow', 'rtk meta'],
  [GUARD_BASH, 'find . -mtime -1', 'allow', 'find with non-name predicate'],
  [GUARD_BASH, 'grep foo bar.txt # bash-guard: allow', 'allow', 'escape hatch'],
];

let pass = 0;
let fail = 0;
for (const [hook, cmd, expected, label] of cases) {
  const { stdout } = run(hook, cmd);
  const got = stdout.includes('"decision":"block"') ? 'block' : 'allow';
  const ok = got === expected;
  const tag = path.basename(hook).replace('.js', '').replace('guard-', '');
  if (ok) {
    pass++;
    console.log(`OK   [${tag}] ${expected.padEnd(5)} ${label}`);
  } else {
    fail++;
    console.log(`FAIL [${tag}] expected=${expected} got=${got}: ${label}`);
    console.log(`     cmd: ${cmd}`);
    if (stdout) console.log(`     stdout: ${stdout.slice(0, 240)}`);
  }
}

// ─── normalize-bash: rewrites + auto-allow behavior ──────────────────────
// [command, expectedRewrite|null, label]
// expectedRewrite === null means "no rewrite expected" (output may be empty
// or contain only permissionDecision). The escape-hatch case is the
// regression we just fixed: it MUST rewrite even with the comment present.
const normalizeCases = [
  ['/opt/homebrew/bin/rg foo', 'rg foo', 'abs-path rg rewritten'],
  ['"grep" foo bar', 'grep foo bar', 'quoted cmd-word rewritten'],
  ['/bin/ls -la | "head" -n 3', 'ls -la | head -n 3', 'compound rewrite'],
  [
    '/opt/homebrew/bin/rg foo # bash-guard: allow',
    'rg foo # bash-guard: allow',
    'escape hatch does NOT skip rewrite (regression fix)',
  ],
  ['ls -la', null, 'no rewrite needed'],
  ['echo hello', null, 'plain command unchanged'],
];

for (const [cmd, want, label] of normalizeCases) {
  const { stdout } = run(NORMALIZE, cmd);
  const { rewritten } = parseNormalize(stdout);
  const got = rewritten;
  const ok = want === null ? got === null : got === want;
  if (ok) {
    pass++;
    console.log(`OK   [normalize-bash] rewrite ${label}`);
  } else {
    fail++;
    console.log(`FAIL [normalize-bash] expected=${JSON.stringify(want)} got=${JSON.stringify(got)}: ${label}`);
    console.log(`     cmd: ${cmd}`);
    if (stdout) console.log(`     stdout: ${stdout.slice(0, 240)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
