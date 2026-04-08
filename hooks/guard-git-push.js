#!/usr/bin/env node
const fs = require('fs');

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const cmd = (input.tool_input?.command || '').trim();
  if (!/^git\s+push\s+/.test(cmd)) process.exit(0);
  if (/^git\s+push\s+origin\s+main\s*$/.test(cmd)) process.exit(0);
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: 'git push with arguments is blocked. Use bare "git push" or run manually with ! git push <args>.',
  }));
  process.exit(0);
}

main();
