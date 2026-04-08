#!/usr/bin/env node
// SessionStart hook: inject output-token protocols as additional context.
// Reads hooks/output-protocols.md and emits it inside a <output-token-protocols>
// tag via the hookSpecificOutput.additionalContext channel. Fails open: any
// error produces an empty additionalContext so the session still starts cleanly.

const fs = require('fs');
const path = require('path');

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}

try {
  const mdPath = path.join(__dirname, 'output-protocols.md');
  const body = fs.readFileSync(mdPath, 'utf8').trim();
  emit(`<output-token-protocols>\n${body}\n</output-token-protocols>`);
} catch (_) {
  emit('');
}
