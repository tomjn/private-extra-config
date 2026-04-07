# private-extra-config

Personal Claude Code plugin for hooks and configuration that are specific to one
user's workflow and not general enough to share.

This repo is both a Claude Code **plugin** and a single-entry **marketplace** —
the same pattern used by `minion-groundwork`. This lets it install via
`/plugin marketplace add` without needing to curate a separate marketplace repo.

## Hooks

### `guard-git-push` (`PreToolUse` on `Bash`)

Blocks `git push` with arguments (e.g. `git push --force`, `git push origin
feature-branch`) while allowing the bare `git push` and the explicit safe
variant `git push origin main`. Anything else must be run manually via the
session `! git push <args>` escape.

**Why:** prevents accidental pushes to wrong branches, force-pushes, and
pushes to non-default remotes.

### `guard-write` (`PreToolUse` on `Write`/`Edit`)

Blocks repeated full-file rewrites via the `Write` tool when an `Edit` would
be cheaper in output tokens. Rules:

1. First `Write` to any given file in a session is **always allowed**.
2. A subsequent `Write` to the same file with content larger than 3000
   characters is **blocked** — the agent is told to use `Edit` instead.
3. `Edit` calls are never blocked, and they count as "touching" the file for
   rule 2 above. So after an Edit, a full Write rewrite of the same file is
   blocked.
4. **Kill switch:** if the agent retries the identical Write (same file, same
   content) after a block, the second attempt goes through. A third identical
   attempt blocks again (the switch resets after each use).
5. Any hook error fails open.

**Why:** large full-file rewrites are the single biggest contributor to output
token usage in long Claude Code sessions — a 10k-char Write costs roughly
2.5k output tokens. Surgical Edits are 10–100× cheaper.

State is tracked per `session_id` in `$TMPDIR/claude-write-guard/`.

## Installation

```
/plugin marketplace add etr/private-extra-config
/plugin install private-extra-config@private-extra-config
```

For a private GitHub repo, ensure your Claude Code instance can authenticate
with GitHub (e.g. SSH keys loaded or `gh auth login` completed).

After install, restart the session or toggle the plugin off/on via `/plugin` so
the hooks are loaded.

## Development

Local edits to this repo are picked up on the next plugin reload, because the
plugin is installed from a git source and Claude Code caches the source tree
under `~/.claude/plugins/cache/private-extra-config/`. For rapid iteration you
can also keep a symlink at `~/.claude/plugins/private-extra-config` pointing
at this checkout — but in that case the plugin won't be in `enabledPlugins`
and won't actually load until properly installed via the marketplace.

### Testing the Write guard

```
bash -c 'cd /tmp && node /home/etr/progs/private-extra-config/hooks/guard-write.js <<EOF
{"session_id":"test","tool_name":"Write","tool_input":{"file_path":"/tmp/x.md","content":"hello"}}
EOF'
```

Empty output = allow. JSON with `"decision":"block"` = block.
