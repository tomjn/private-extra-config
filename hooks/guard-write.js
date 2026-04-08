#!/usr/bin/env node
/**
 * PreToolUse hook for Write and Edit.
 *
 * Purpose: prevent output-token waste from full-file rewrites via the Write tool
 * when an Edit would do.
 *
 * Rule:
 *   Block a Write when ALL of the following hold:
 *     1. The target file has already been touched (Write or Edit) earlier in this session.
 *     2. The content being written is larger than THRESHOLD_CHARS.
 *     3. The exact same (file_path, content) Write was not previously blocked
 *        in this session (kill-switch: a second identical attempt goes through).
 *
 *   Otherwise: allow. In particular, the *first* Write of a file in a session is
 *   always allowed — the rule only kicks in on repeat full rewrites.
 *
 *   For Edit calls: never block; just record the touch so subsequent Writes see it.
 *
 * State is kept per session_id in $TMPDIR/claude-write-guard/<session_id>.json.
 * Any error in the hook fails open (allows the tool).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const THRESHOLD_CHARS = 3000;
const STATE_DIR = path.join(process.env.TMPDIR || '/tmp', 'claude-write-guard');
const MAX_BLOCKED_HASHES = 200;

function allow() {
  // Exit 0 with no stdout = allow
  process.exit(0);
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function loadState(sessionId) {
  try {
    const file = path.join(STATE_DIR, `${sessionId}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { touched: {}, blockedHashes: [] };
  }
}

function saveState(sessionId, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, `${sessionId}.json`);
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch {
    // Ignore state-save failures; correctness is not critical here.
  }
}

function shortHash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return allow();
  }

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id || 'no-session';
  const filePath = toolInput.file_path;

  if (!filePath) return allow();
  if (toolName !== 'Write' && toolName !== 'Edit') return allow();

  const state = loadState(sessionId);
  const prevTouches = state.touched[filePath] || 0;

  // Edit: never blocks, always records.
  if (toolName === 'Edit') {
    state.touched[filePath] = prevTouches + 1;
    saveState(sessionId, state);
    return allow();
  }

  // Write path.
  const content = typeof toolInput.content === 'string' ? toolInput.content : '';
  const contentHash = shortHash(content);
  const blockKey = `${filePath}:${contentHash}`;

  // Kill-switch: if we blocked this exact (file, content) before, let it through now.
  if (state.blockedHashes.includes(blockKey)) {
    state.touched[filePath] = prevTouches + 1;
    // Remove so a third identical attempt would block again (reset the switch).
    state.blockedHashes = state.blockedHashes.filter((k) => k !== blockKey);
    saveState(sessionId, state);
    return allow();
  }

  // Allow first-touch regardless of size.
  if (prevTouches === 0) {
    state.touched[filePath] = 1;
    saveState(sessionId, state);
    return allow();
  }

  // Allow small writes.
  if (content.length <= THRESHOLD_CHARS) {
    state.touched[filePath] = prevTouches + 1;
    saveState(sessionId, state);
    return allow();
  }

  // Repeat large Write on a file already touched this session -> block.
  state.blockedHashes.push(blockKey);
  if (state.blockedHashes.length > MAX_BLOCKED_HASHES) {
    state.blockedHashes = state.blockedHashes.slice(-MAX_BLOCKED_HASHES);
  }
  // Intentionally do NOT increment touched here: the tool call is being rejected,
  // so it didn't actually happen from the file's point of view.
  saveState(sessionId, state);

  const reason =
    `guard-write: blocked Write to '${filePath}' (${content.length} chars). ` +
    `This file was already touched earlier in the session, and full rewrites ` +
    `of existing files cost a lot of output tokens. ` +
    `Use the Edit tool with targeted changes instead. ` +
    `If you genuinely need to replace the entire file, retry the identical Write ` +
    `and the kill-switch will allow the second attempt through.`;
  block(reason);
}

main();
