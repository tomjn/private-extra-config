#!/usr/bin/env node
const input = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
const cmd = (input.tool_input?.command || '').trim();

if (/^git\s+push\s+/.test(cmd)) {
  console.log(JSON.stringify({
    decision: 'block',
    reason: 'git push with arguments is blocked. Use bare "git push" or run manually with ! git push <args>.'
  }));
}
