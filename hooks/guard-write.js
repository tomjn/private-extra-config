#!/usr/bin/env node
/**
 * PreToolUse hook for Write, Edit, and NotebookEdit.
 *
 * Purpose: prevent output-token waste from full-file rewrites via the Write tool
 * when an Edit would do.
 *
 * Rule:
 *   Block a Write when ALL of the following hold:
 *     1. The target file has already been touched (Write/Edit/NotebookEdit)
 *        earlier in this session.
 *     2. The content being written is larger than THRESHOLD_CHARS.
 *     3. The exact same (file_path, content) Write was not previously blocked
 *        in this session (kill-switch: a second identical attempt goes through).
 *
 *   Otherwise: allow. In particular, the *first* Write of a file in a session is
 *   always allowed — the rule only kicks in on repeat full rewrites.
 *
 *   For Edit/NotebookEdit calls: never block; just record the touch so subsequent
 *   Writes see it. (NotebookEdit is inherently per-cell, not full-file.)
 *
 * State is kept per session_id in $TMPDIR/claude-write-guard/<session_id>.json.
 * Old state files are GC'd probabilistically (see STATE_TTL_MS / GC_PROBABILITY).
 * Any error in the hook fails open (allows the tool).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const THRESHOLD_CHARS = 3000;
const STATE_DIR = path.join(process.env.TMPDIR || '/tmp', 'claude-write-guard');
const MAX_BLOCKED_HASHES = 200;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const GC_PROBABILITY = 0.05; // ~1 in 20 invocations runs cleanup

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

function gcOldState() {
  // Best-effort: remove session state files older than STATE_TTL_MS. Swallow
  // all errors — this is housekeeping, not correctness.
  try {
    const now = Date.now();
    const entries = fs.readdirSync(STATE_DIR);
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(STATE_DIR, name);
      try {
        const st = fs.statSync(file);
        if (now - st.mtimeMs > STATE_TTL_MS) fs.unlinkSync(file);
      } catch {
        // per-file errors ignored
      }
    }
  } catch {
    // dir doesn't exist yet, or unreadable — fine
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return allow();
  }

  if (Math.random() < GC_PROBABILITY) gcOldState();

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id || 'no-session';
  // Write/Edit use file_path; NotebookEdit uses notebook_path.
  const filePath = toolInput.file_path || toolInput.notebook_path;

  if (!filePath) return allow();
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'NotebookEdit') return allow();

  const state = loadState(sessionId);
  const prevTouches = state.touched[filePath] || 0;

  // Edit and NotebookEdit: never block, always record. NotebookEdit is
  // inherently per-cell, not a full-file rewrite, so the output-token waste
  // concern doesn't apply.
  if (toolName === 'Edit' || toolName === 'NotebookEdit') {
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
