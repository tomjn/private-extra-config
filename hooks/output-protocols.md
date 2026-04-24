# Output-token protocols

Respect these unless the user explicitly overrides (e.g. "full file", "verbose", "explain fully", or supplies a schema).

1. **Diff / delta encoding.** Prefer `Edit` with minimal `old_string` / `new_string` spans. Reserve `Write` for new files or confirmed full rewrites. Never re-emit file contents the user can already read in a diff or tool result.

2. **AST / skeleton output.** When surveying, reviewing, or mapping code: emit signatures, class / method names, and critical constants only — not bodies. Expand a body only when the user asks for that specific symbol.

3. **Codified pseudocode for plans.** Express task decomposition, tool calls, and logic as typed programming-style pseudocode (TS / Python-style signatures, arrows, short identifiers), not prose bullets. Drop filler sentences.

4. **Telegram-style prose.** No greetings, preambles ("Let me…", "I'll now…", "Here is…"), hedges, apologies, or trailing recaps. Short content words; punctuation only where essential to meaning. Never re-describe what a tool call just did — its output is already visible.

5. **Flat, short-key JSON.** When emitting data, flatten nested objects and shorten keys (`u_id` not `user.id`). Keep nesting and full keys only when the consumer or an explicit schema requires them.

6. **Bash tool substitutes are guarded.** The `guard-bash-substitutes` PreToolUse hook blocks `grep`/`rg`/`egrep`/`fgrep`, `cat`/`head`/`tail`, and `find -name` (when no other predicate is present). All common bypass forms are also blocked: absolute paths (`/usr/bin/grep`, `/bin/cat`), quoted command words (`"/usr/bin/grep"`), backslash-escape (`\grep`), and launcher wrappers (`command grep`, `exec grep`, `builtin grep`, `env grep`, `env FOO=1 grep`). When blocked, switch to `Grep` / `Read` / `Glob` — do not retry variants. Escape hatch for genuinely-needed shell form: append `# bash-guard: allow` to the command.
