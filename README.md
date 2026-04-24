# private-extra-config

Personal Claude Code plugin for hooks and configuration that are specific to one
user's workflow and not general enough to share.

This repo is both a Claude Code **plugin** and a single-entry **marketplace** —
the same pattern used by `minion-groundwork`. This lets it install via
`/plugin marketplace add` without needing to curate a separate marketplace repo.

## Attribution

This is a fork of [etr/private-extra-config](https://github.com/etr/private-extra-config)
by **Sebastiano Merlino** — all four hooks (`guard-git-push`,
`guard-bash-substitutes`, `guard-write`, `inject-output-protocols`) and the
plugin-as-marketplace structure are his original work. This fork adds hardening
against common bypass variants, a shared bash-parse library, `NotebookEdit`
coverage and state-file GC in `guard-write`, and is maintained separately
because the upstream repo has been quiet. Original MIT license preserved.

## Hooks

### `guard-git-push` (`PreToolUse` on `Bash`)

Blocks `git push` with arguments (e.g. `git push --force`, `git push origin
feature-branch`) while allowing the bare `git push` and the explicit safe
variant `git push origin main`. Anything else must be run manually via the
session `! git push <args>` escape.

Common bypass forms are also blocked: absolute paths (`/usr/bin/git push -f`),
quoted command words (`"git" push -f`), backslash-escape (`\git push -f`),
launcher wrappers (`command`/`exec`/`builtin`/`env git push -f`), the
[rtk](https://github.com/rtk-ai/rtk) token-saver proxy (`rtk git push -f`),
and chained/piped forms (`foo && git push -f`, `git push -f | tee log`).
Parsing fails open on multi-line commands and heredocs.

**Escape hatch:** append `# git-push-guard: allow` to the command for a
one-off exception the rule doesn't cover.

**Known limitation:** `sudo`/`nice`/`time` are not unwrapped (their flag
semantics would create false positives; `sudo` also prompts non-interactively
so it isn't a practical bypass here).

**Why:** prevents accidental pushes to wrong branches, force-pushes, and
pushes to non-default remotes.

### `guard-bash-substitutes` (`PreToolUse` on `Bash`)

Blocks bash invocations that duplicate a dedicated Claude tool, because the
inlined command text becomes orchestrator output and then sits in cache reads
on every subsequent turn.

Blocked patterns (only the upstream command of each compound segment is
checked):

- `grep | rg | egrep | fgrep ...` → use the **Grep** tool
- `cat | head | tail <file>` → use the **Read** tool
- `find <path> -name <pattern>` (only when no other predicate like `-mtime`,
  `-type`, `-size`, `-perm`, `-newer` is present) → use the **Glob** tool

Common bypass forms are blocked in the same way as `guard-git-push`, including
absolute paths, quoted forms, backslash-escape, launcher wrappers
(`command`/`exec`/`builtin`/`env`), and the [rtk](https://github.com/rtk-ai/rtk)
token-saver proxy (`rtk grep foo` unwraps to `grep foo` and is blocked).

Allowed (intentionally narrow rule set, false positives are worse than false
negatives):

- Pipe downstream commands like `ps aux | grep claude` — the second command
  is processing dynamic output, not a file
- `find` with non-name predicates (`-mtime`, `-type`, `-size`, etc.)
- `ls`, `sed`, `awk`, `echo`, `printf`, `sort`, `uniq`, `wc` — too many
  legitimate uses to be worth blocking
- Multi-line commands and heredocs (fail open — too risky to parse)
- Anything containing `# bash-guard: allow` (explicit escape hatch)
- Any parse error or unexpected input

**Why:** measured sessions show ~48k output tokens going to bash `grep`/`rg`,
~23k to `cat`/`head`/`tail`, and ~41k to `ls`/`find` per day — most of which
has a zero-cost dedicated-tool equivalent. Blocking with a clear hint is
cheaper than relying on prompt discipline.

### `guard-write` (`PreToolUse` on `Write`/`Edit`/`NotebookEdit`)

Blocks repeated full-file rewrites via the `Write` tool when an `Edit` would
be cheaper in output tokens. Rules:

1. First `Write` to any given file in a session is **always allowed**.
2. A subsequent `Write` to the same file with content larger than 3000
   characters is **blocked** — the agent is told to use `Edit` instead.
3. `Edit` and `NotebookEdit` calls are never blocked, and they count as
   "touching" the file for rule 2 above. So after an Edit, a full Write
   rewrite of the same file is blocked. `NotebookEdit` is inherently per-cell,
   so the output-token concern doesn't apply to it directly.
4. **Kill switch:** if the agent retries the identical Write (same file, same
   content) after a block, the second attempt goes through. A third identical
   attempt blocks again (the switch resets after each use).
5. Any hook error fails open.

**Why:** large full-file rewrites are the single biggest contributor to output
token usage in long Claude Code sessions — a 10k-char Write costs roughly
2.5k output tokens. Surgical Edits are 10–100× cheaper.

State is tracked per `session_id` in `$TMPDIR/claude-write-guard/`. Session
state files are probabilistically garbage-collected after 7 days (~1 in 20
invocations runs the cleanup).

### `inject-output-protocols` (`SessionStart` on `startup|resume|clear|compact`)

Reads `hooks/output-protocols.md` and injects its contents into Claude's
context once per session via `hookSpecificOutput.additionalContext`, wrapped in
an `<output-token-protocols>` tag. Claude sees the text as a system reminder
and is instructed to respect the protocols unless the user explicitly
overrides (`"full file"`, `"verbose"`, `"explain fully"`, schema supplied).

**Why:** the protocols codify diff-first editing, skeleton/AST output, typed
pseudocode for plans, telegram-style prose, and flat short-key JSON — all
aimed at cutting output-token usage with no per-turn overhead (SessionStart
fires once, not per prompt).

**Editing the protocols:** just edit `hooks/output-protocols.md`. No code
change needed; the hook reads the file at session start. Fails open on any
read error.

## Installation

```
/plugin marketplace add tomjn/private-extra-config
/plugin install private-extra-config@private-extra-config
```

For a private GitHub repo, ensure your Claude Code instance can authenticate
with GitHub (e.g. SSH keys loaded or `gh auth login` completed).

After install, restart the session or toggle the plugin off/on via `/plugin` so
the hooks are loaded.

> Installing the upstream (`etr/private-extra-config`) instead will give you
> the original hooks without the hardening added in this fork.

## Development

Local edits to this repo are picked up on the next plugin reload, because the
plugin is installed from a git source and Claude Code caches the source tree
under `~/.claude/plugins/cache/private-extra-config/`. For rapid iteration you
can also keep a symlink at `~/.claude/plugins/private-extra-config` pointing
at this checkout — but in that case the plugin won't be in `enabledPlugins`
and won't actually load until properly installed via the marketplace.

### Shared parsing library

Both bash guards (`guard-git-push`, `guard-bash-substitutes`) share
`hooks/lib/bash-parse.js`, which handles tokenization, launcher-wrapper
unwrapping (`command`/`exec`/`builtin`/`env`/`rtk`), env-assignment stripping,
quote/backslash/path normalization, and pipeline segmentation. Keeping this
in one place means bypass closures stay consistent across guards.

`rtk` is treated as a launcher wrapper because
[rtk](https://github.com/rtk-ai/rtk) proxies the command after it — `rtk grep
foo` runs grep with token-saver output filtering, so it is semantically
equivalent to `grep foo` for bypass-closure purposes. `rtk`'s own meta
subcommands (`rtk gain`, `rtk discover`, `rtk proxy …`) unwrap to `gain` /
`discover` / `proxy …` and are not blocked.

### Testing the Write guard

```
bash -c 'node hooks/guard-write.js <<EOF
{"session_id":"test","tool_name":"Write","tool_input":{"file_path":"/tmp/x.md","content":"hello"}}
EOF'
```

Empty output = allow. JSON with `"decision":"block"` = block.
