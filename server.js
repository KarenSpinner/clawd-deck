// Clawd Deck — local dashboard server for concurrent Claude Code sessions.
//
// Data sources, in order of trust:
//   1. `claude agents --json`  (supported CLI surface: live sessions, names, status)
//   2. Claude Code hooks POSTed to /hook/:event  (instant events, todos, notifications)
//   3. Transcript JSONL under ~/.claude/projects  (context usage, conversation, artifacts)
// The transcript format is officially undocumented and may change between Claude Code
// releases — every parse here is defensive: a missing field greys out a feature, it
// never crashes the dashboard.

const express = require('express');
const http = require('http');
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 4839;
// LaunchAgents get a minimal PATH, so resolve tmux explicitly
const TMUX_BIN = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']
  .find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'tmux';
const CONTEXT_WINDOW = 1_000_000; // claude-fable-5[1m]
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ENDED_RETENTION_MS = 60 * 60 * 1000; // keep ended sessions on the board 1h

// ---------------------------------------------------------------- state

// sessionId -> session record
const sessions = new Map();
const hiddenSessions = new Set(); // our own headless nudge runs — never shown as cards
const dismissed = new Set();      // ended cards the user closed; cleared if the session returns
let tmuxSessions = new Set(); // names of live tmux sessions ("cc-foo")
let prs = { mine: [], needsMe: [], error: null, updatedAt: 0 };
let config = { autoNudge: false, titles: {} };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
config.titles = config.titles || {}; // sessionId -> { custom?, generated? }

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {}
}

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      sessionId: id,
      name: null,
      subtitle: null,      // first prompt from history.jsonl
      cwd: null,
      gitBranch: null,
      pid: null,
      kind: null,
      alive: false,
      agentStatus: null,   // from `claude agents --json`: idle | waiting | ...
      agentStatusAt: 0,
      waitingFor: null,
      hookStatus: null,    // from hooks: working | idle | waiting | ended
      hookStatusAt: 0,
      notification: null,
      compacting: false,
      startedAt: null,
      endedAt: null,
      lastActivityAt: 0,
      todos: null,
      contextTokens: null,
      contextPct: null,
      model: null,
      transcriptPath: null,
      artifacts: { files: [], urls: [] },
      artifactsScannedAt: 0,
      nudge: null,         // { state: running|done|error, summary, at }
    });
  }
  return sessions.get(id);
}

// Effective status shown on the card. Four live states:
//   waiting — genuinely blocked on the user (permission / input request)
//   ready   — turn finished, waiting for the user's next prompt
//   working — mid-turn
//   idle    — nothing recent
// "waiting" from the agents poller always surfaces; "ready" deliberately
// survives a newer poller "idle" (idle is uninformative after a Stop).
function effectiveStatus(s) {
  if (s.hookStatus === 'ended' || (!s.alive && s.endedAt)) return 'ended';
  if (s.agentStatus === 'waiting') return 'waiting';
  if (s.hookStatus === 'waiting' && s.hookStatusAt >= s.agentStatusAt) return 'waiting';
  if (s.agentStatus === 'working' && s.agentStatusAt > s.hookStatusAt) return 'working';
  if (s.hookStatus === 'working') {
    // a missed Stop hook must not pin "working" forever — trust a clearly newer poller idle
    if (s.agentStatus === 'idle' && s.agentStatusAt > s.hookStatusAt + 60000) return 'idle';
    return 'working';
  }
  if (s.hookStatus === 'ready') return 'ready';
  return s.agentStatus || s.hookStatus || 'idle';
}

function publicSession(s) {
  const t = config.titles[s.sessionId] || {};
  return {
    sessionId: s.sessionId,
    name: t.custom || t.generated || s.name,
    rawName: s.name,
    subtitle: s.subtitle,
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    status: effectiveStatus(s),
    waitingFor: s.waitingFor,
    notification: s.notification,
    compacting: s.compacting,
    alive: s.alive,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    lastActivityAt: s.lastActivityAt,
    todos: s.todos,
    contextTokens: s.contextTokens,
    contextPct: s.contextPct,
    model: s.model,
    artifactCount: (s.artifacts.files.length + s.artifacts.urls.length) || 0,
    embeddable: !!(s.name && tmuxSessions.has('cc-' + s.name)),
    tmuxTarget: s.name && tmuxSessions.has('cc-' + s.name) ? 'cc-' + s.name : null,
    nudge: s.nudge,
  };
}

// ---------------------------------------------------------------- broadcast

const wsClients = new Set();
let broadcastTimer = null;

function snapshot() {
  const list = [...sessions.values()]
    .filter(s => !hiddenSessions.has(s.sessionId) && !dismissed.has(s.sessionId))
    .filter(s => s.alive || (s.endedAt && Date.now() - s.endedAt < ENDED_RETENTION_MS))
    .map(publicSession)
    .sort((a, b) => {
      const rank = st => (st === 'waiting' ? 0 : st === 'ready' ? 1 : st === 'working' ? 2 : st === 'idle' ? 3 : 4);
      return rank(a.status) - rank(b.status) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });
  return { type: 'snapshot', sessions: list, prs, config, now: Date.now() };
}

function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const msg = JSON.stringify(snapshot());
    for (const ws of wsClients) { try { ws.send(msg); } catch {} }
  }, 250);
}

// ---------------------------------------------------------------- agents poller

function pollAgents() {
  execFile('claude', ['agents', '--json'], { timeout: 10000 }, (err, stdout) => {
    if (err) return; // claude busy/missing — keep last known state
    let list;
    try { list = JSON.parse(stdout); } catch { return; }
    if (!Array.isArray(list)) return;
    const seen = new Set();
    for (const a of list) {
      if (!a || !a.sessionId || a.kind !== 'interactive') continue;
      seen.add(a.sessionId);
      dismissed.delete(a.sessionId);
      const s = getSession(a.sessionId);
      const prevStatus = s.agentStatus;
      s.alive = true;
      s.endedAt = null;
      if (s.hookStatus === 'ended') s.hookStatus = null;
      s.name = a.name || s.name;
      s.cwd = a.cwd || s.cwd;
      s.pid = a.pid;
      s.kind = a.kind;
      s.startedAt = a.startedAt || s.startedAt;
      s.agentStatus = (a.status === 'busy' || a.status === 'running') ? 'working' : (a.status || null);
      s.waitingFor = a.status === 'waiting' ? (a.waitingFor || 'input') : null;
      if (a.status !== prevStatus) s.agentStatusAt = Date.now();
      attachSubtitle(s);
    }
    for (const s of sessions.values()) {
      // only the poller may declare dead what the poller has seen; hook-only
      // sessions (headless runs, race windows) expire by inactivity instead
      if (s.alive && !seen.has(s.sessionId) && s.agentStatus !== null) {
        s.alive = false;
        if (!s.endedAt) s.endedAt = Date.now();
      }
      if (s.alive && s.agentStatus === null &&
          s.lastActivityAt && Date.now() - s.lastActivityAt > 10 * 60 * 1000) {
        s.alive = false;
        if (!s.endedAt) s.endedAt = s.lastActivityAt;
      }
      // READY that sat unread for 30 min fades to idle so a morning board isn't all blue
      if (s.hookStatus === 'ready' && Date.now() - s.hookStatusAt > 30 * 60 * 1000) {
        s.hookStatus = 'idle';
      }
    }
    broadcast();
  });
  execFile(TMUX_BIN, ['list-sessions', '-F', '#{session_name}'], { timeout: 5000 }, (err, stdout) => {
    tmuxSessions = new Set(err ? [] : stdout.split('\n').filter(Boolean));
  });
}
setInterval(pollAgents, 3000);
pollAgents();

// ---------------------------------------------------------------- history.jsonl (titles)

const historyBySession = new Map(); // sessionId -> { firstPrompt, project, lastTs }
let historyOffset = 0;

function attachSubtitle(s) {
  if (s.subtitle) return;
  const h = historyBySession.get(s.sessionId);
  if (h) s.subtitle = String(h.firstPrompt).slice(0, 140);
}

function ingestHistory() {
  let fd;
  try {
    const size = fs.statSync(HISTORY_FILE).size;
    if (size < historyOffset) historyOffset = 0; // rotated
    if (size === historyOffset) return;
    fd = fs.openSync(HISTORY_FILE, 'r');
    const buf = Buffer.alloc(size - historyOffset);
    fs.readSync(fd, buf, 0, buf.length, historyOffset);
    historyOffset = size;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e.sessionId || !e.display) continue;
      const h = historyBySession.get(e.sessionId);
      if (!h) {
        historyBySession.set(e.sessionId, { firstPrompt: e.display, project: e.project, lastTs: e.timestamp });
      } else {
        h.lastTs = e.timestamp;
      }
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  // attach subtitles to known sessions
  for (const s of sessions.values()) {
    if (!s.subtitle) {
      const h = historyBySession.get(s.sessionId);
      if (h) s.subtitle = String(h.firstPrompt).slice(0, 140);
    }
  }
}
setInterval(() => { ingestHistory(); broadcast(); }, 5000);
ingestHistory();

// ---------------------------------------------------------------- transcripts

let projectDirs = [];
function refreshProjectDirs() {
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR)
      .map(d => path.join(PROJECTS_DIR, d))
      .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  } catch { projectDirs = []; }
}
refreshProjectDirs();
setInterval(refreshProjectDirs, 60000);

function findTranscript(s) {
  if (s.transcriptPath && fs.existsSync(s.transcriptPath)) return s.transcriptPath;
  for (const dir of projectDirs) {
    const p = path.join(dir, s.sessionId + '.jsonl');
    if (fs.existsSync(p)) { s.transcriptPath = p; return p; }
  }
  return null;
}

function readTail(file, bytes) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

// Context gauge + branch/model from the tail of each live session's transcript.
function refreshTranscriptTails() {
  for (const s of sessions.values()) {
    if (!s.alive) continue;
    const file = findTranscript(s);
    if (!file) continue;
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (s._tailMtime === mtime) continue;
      s._tailMtime = mtime;
      s.lastActivityAt = mtime;
    } catch { continue; }
    const lines = readTail(file, 256 * 1024).split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e.type === 'assistant' && e.message && e.message.usage) {
        const u = e.message.usage;
        const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
          + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        if (total > 0) {
          s.contextTokens = total;
          s.contextPct = Math.min(100, Math.round((total / CONTEXT_WINDOW) * 1000) / 10);
        }
        if (e.message.model) s.model = e.message.model;
        break;
      }
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e.gitBranch) { s.gitBranch = e.gitBranch; break; }
    }
  }
  broadcast();
}
setInterval(refreshTranscriptTails, 5000);

// Extract clean text from a transcript message.content (string or array).
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n\n');
}

function parseConversation(file) {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    // isMeta marks injected machinery (skill loads, command output) that rides
    // in as user-role entries but was never typed by the human
    if (e.isSidechain || e.isMeta) continue;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const msg = e.message;
    if (!msg) continue;
    // skip tool_result-only user entries (they're tool output, not the human)
    if (e.type === 'user' && Array.isArray(msg.content) &&
        msg.content.every(b => b && b.type === 'tool_result')) continue;
    let text = contentToText(msg.content);
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (!text) continue;
    // belt-and-braces for transcript variants where isMeta is absent
    if (/^(Base directory for this skill|Caveat: the messages below|<command-name>|<local-command-stdout>|<task-notification>|<teammate-message>)/.test(text)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === e.type) {
      // consecutive same-role fragments (status notes between tool calls) read
      // as one turn, and copy as one turn
      prev.text += '\n\n' + text;
    } else {
      out.push({ role: e.type, text, ts: e.timestamp || null, uuid: e.uuid || null });
    }
  }
  return out;
}

const ARTIFACT_URL_RE = /https:\/\/(?:claude\.ai\/public\/artifacts\/[\w-]+|[\w.-]*claudeusercontent\.com\/[\w\/-]+)/g;

function scanArtifacts(s) {
  const file = findTranscript(s);
  if (!file) return;
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return; }
  if (s.artifactsScannedAt >= mtime) return;
  s.artifactsScannedAt = mtime;
  const files = new Set();
  const urls = new Set();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    if (!line.includes('"tool_use"') && !line.includes('claudeusercontent') && !line.includes('/artifacts/')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const content = e.message && e.message.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_use' && b.input && typeof b.input.file_path === 'string' &&
            ['Write', 'NotebookEdit', 'Artifact'].includes(b.name)) {
          files.add(b.input.file_path);
        }
      }
    }
    for (const m of line.match(ARTIFACT_URL_RE) || []) urls.add(m.replace(/\\+$/, ''));
  }
  s.artifacts = { files: [...files], urls: [...urls] };
}

setInterval(() => {
  for (const s of sessions.values()) if (s.alive) scanArtifacts(s);
  broadcast();
}, 60000);

// ---------------------------------------------------------------- descriptive titles

// Claude Code auto-names sessions "<folder>-<2 hex chars>" (and cc's fallback is
// "<folder>-HHMMSS"). Those tell you nothing at a glance, so for them we generate
// a short descriptive title from the session's first prompt with one tiny headless
// haiku call, cached forever in config.json. Deliberate names are left alone, and
// a custom title set from the UI always wins.
function looksAutoNamed(s) {
  if (!s.name || !s.cwd) return false;
  const base = path.basename(s.cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped + '-([0-9a-f]{2}|\\d{6})$').test(s.name.toLowerCase());
}

const titleQueue = [];
const titleAttempts = new Map();
let titleGenBusy = false;

function scanForTitleGen() {
  for (const s of sessions.values()) {
    if (!s.alive || !s.subtitle || !looksAutoNamed(s)) continue;
    const t = config.titles[s.sessionId];
    if (t && (t.custom || t.generated)) continue;
    if ((titleAttempts.get(s.sessionId) || 0) >= 2) continue;
    if (!titleQueue.includes(s.sessionId)) titleQueue.push(s.sessionId);
  }
  pumpTitleQueue();
}

function pumpTitleQueue() {
  if (titleGenBusy || !titleQueue.length) return;
  const id = titleQueue.shift();
  const s = sessions.get(id);
  if (!s || !s.subtitle) return pumpTitleQueue();
  titleGenBusy = true;
  titleAttempts.set(id, (titleAttempts.get(id) || 0) + 1);
  const hid = randomUUID();
  hiddenSessions.add(hid);
  const prompt =
    'Write a short descriptive title, 3 to 6 plain words, for a work session that opened with the request below. ' +
    'Reply with the title only — no quotes, no trailing punctuation.\n\nRequest: ' + s.subtitle;
  const child = spawn('claude', ['-p', '--model', 'haiku', '--session-id', hid, prompt],
    { cwd: os.homedir(), timeout: 60000 });
  let out = '';
  let finished = false;
  child.stdout.on('data', d => { if (out.length < 2000) out += d; });
  const done = () => {
    if (finished) return;
    finished = true;
    titleGenBusy = false;
    const title = out.trim().split('\n')[0].replace(/^["']|["']$/g, '').trim().slice(0, 60);
    if (title) {
      config.titles[id] = { ...(config.titles[id] || {}), generated: title };
      saveConfig();
      broadcast();
    }
    pumpTitleQueue();
  };
  child.on('close', done);
  child.on('error', done);
}
setTimeout(scanForTitleGen, 8000);
setInterval(scanForTitleGen, 15000);

// ---------------------------------------------------------------- PR poller

const PR_QUERY = (search) => `
query {
  search(query: "${search}", type: ISSUE, first: 30) {
    nodes {
      ... on PullRequest {
        number title url isDraft reviewDecision updatedAt
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

function ghSearch(search) {
  return new Promise((resolve) => {
    execFile('gh', ['api', 'graphql', '-f', 'query=' + PR_QUERY(search)], { timeout: 30000 },
      (err, stdout) => {
        if (err) return resolve({ error: String(err.message || err).split('\n')[0] });
        try {
          const nodes = JSON.parse(stdout).data.search.nodes || [];
          resolve({
            prs: nodes.filter(n => n && n.number).map(n => ({
              repo: n.repository.nameWithOwner,
              number: n.number,
              title: n.title,
              url: n.url,
              isDraft: n.isDraft,
              review: n.reviewDecision,
              ci: (((n.commits || {}).nodes || [])[0] || {}).commit?.statusCheckRollup?.state || null,
              updatedAt: n.updatedAt,
            })),
          });
        } catch (e) { resolve({ error: 'parse: ' + e.message }); }
      });
  });
}

async function pollPRs() {
  const [mine, needsMe] = await Promise.all([
    ghSearch('is:pr is:open author:@me'),
    ghSearch('is:pr is:open review-requested:@me'),
  ]);
  prs = {
    mine: mine.prs || [],
    needsMe: needsMe.prs || [],
    error: mine.error || needsMe.error || null,
    updatedAt: Date.now(),
  };
  broadcast();
}
setInterval(pollPRs, 60000);
pollPRs();

// ---------------------------------------------------------------- memory nudge

function runNudge(s) {
  const file = findTranscript(s);
  if (!file) { s.nudge = { state: 'error', summary: 'no transcript found', at: Date.now() }; broadcast(); return; }
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir();
  const prompt =
    `Read the Claude Code session transcript at ${file} . ` +
    `Identify durable facts worth remembering from it (user preferences, corrections, project decisions, ongoing work) ` +
    `and update your auto-memory files accordingly, following your memory instructions. ` +
    `Skip anything the repo or existing memories already record. ` +
    `Reply with one line summarizing what you saved, or "nothing new".`;
  s.nudge = { state: 'running', summary: null, at: Date.now() };
  broadcast();
  const nudgeId = randomUUID();
  hiddenSessions.add(nudgeId);
  const child = spawn('claude',
    ['-p', '--session-id', nudgeId, '--permission-mode', 'acceptEdits', prompt],
    { cwd, timeout: 5 * 60 * 1000 });
  let out = '';
  child.stdout.on('data', d => { if (out.length < 20000) out += d; });
  child.on('close', (code) => {
    s.nudge = code === 0
      ? { state: 'done', summary: out.trim().slice(0, 300), at: Date.now() }
      : { state: 'error', summary: ('exit ' + code + ': ' + out.trim()).slice(0, 300), at: Date.now() };
    broadcast();
  });
  child.on('error', (e) => {
    s.nudge = { state: 'error', summary: String(e.message).slice(0, 300), at: Date.now() };
    broadcast();
  });
}

// ---------------------------------------------------------------- hooks receiver

const app = express();
app.use(express.json({ limit: '2mb' }));

app.post('/hook/:event', (req, res) => {
  res.json({ ok: true });
  const b = req.body || {};
  const id = b.session_id;
  if (!id) return;
  const s = getSession(id);
  s.lastActivityAt = Date.now();
  attachSubtitle(s);
  if (req.params.event !== 'SessionEnd') { s.alive = true; s.endedAt = null; dismissed.delete(id); }
  if (b.transcript_path) s.transcriptPath = b.transcript_path;
  if (b.cwd) s.cwd = s.cwd || b.cwd;
  const setHookStatus = (st) => { s.hookStatus = st; s.hookStatusAt = Date.now(); };
  switch (req.params.event) {
    case 'SessionStart':
      if (b.model) s.model = typeof b.model === 'string' ? b.model : (b.model.id || s.model);
      setHookStatus('idle');
      break;
    case 'UserPromptSubmit':
      s.notification = null;
      setHookStatus('working');
      break;
    case 'Stop':
      s.notification = null;
      setHookStatus('ready');
      break;
    case 'Notification': {
      const kind = String(b.notification_type || b.notificationType || b.type || '');
      const message = String(b.message || b.title || '');
      console.log('[notification]', id.slice(0, 8), kind || '(no type)', '·', message.slice(0, 120));
      const needsYou = /permission|elicitation|needs_input/i.test(kind) ||
        /permission|approv|allow|authoriz/i.test(message);
      if (needsYou) {
        s.notification = (message || 'needs your attention').slice(0, 200);
        setHookStatus('waiting');
      } else if (!/auth_success/i.test(kind)) {
        // finished-turn / idle nudges — and anything unrecognized — show READY, not
        // blocked. A genuine block self-corrects within ~3s via the agents poller.
        s.notification = (message || 'ready for you').slice(0, 200);
        setHookStatus('ready');
      }
      break;
    }
    case 'PreCompact':
      s.compacting = true;
      setTimeout(() => { s.compacting = false; broadcast(); }, 30000);
      break;
    case 'SessionEnd':
      s.alive = false; s.endedAt = Date.now();
      setHookStatus('ended');
      if (config.autoNudge) runNudge(s);
      break;
    case 'PostToolUse':
      if (b.tool_name === 'TodoWrite' || (b.tool_input && Array.isArray(b.tool_input.todos))) {
        const todos = b.tool_input && b.tool_input.todos;
        if (Array.isArray(todos)) {
          s.todos = todos.map(t => ({
            content: t.content || t.activeForm || '(unknown)',
            status: t.status || 'pending',
          })).slice(0, 50);
        }
      }
      break;
  }
  broadcast();
});

// ---------------------------------------------------------------- API

app.get('/api/state', (req, res) => res.json(snapshot()));

app.get('/api/session/:id/conversation', (req, res) => {
  const s = sessions.get(req.params.id);
  const file = s && findTranscript(s);
  if (!file) return res.status(404).json({ error: 'no transcript' });
  res.json({ messages: parseConversation(file) });
});

app.get('/api/session/:id/artifacts', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'unknown session' });
  scanArtifacts(s);
  res.json(s.artifacts);
});

app.post('/api/session/:id/memory-nudge', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'unknown session' });
  if (s.nudge && s.nudge.state === 'running') return res.json({ ok: true, already: true });
  runNudge(s);
  res.json({ ok: true });
});

app.post('/api/session/:id/title', (req, res) => {
  const title = String((req.body || {}).title || '').trim().slice(0, 60);
  const t = config.titles[req.params.id] || {};
  if (title) t.custom = title; else delete t.custom;
  config.titles[req.params.id] = t;
  saveConfig();
  broadcast();
  res.json({ ok: true, title: title || null });
});

app.post('/api/session/:id/dismiss', (req, res) => {
  dismissed.add(req.params.id);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/dismiss-ended', (req, res) => {
  for (const s of sessions.values()) if (!s.alive) dismissed.add(s.sessionId);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/config', (req, res) => {
  if (typeof (req.body || {}).autoNudge === 'boolean') config.autoNudge = req.body.autoNudge;
  saveConfig();
  broadcast();
  res.json(config);
});

// static UI + vendored xterm straight out of node_modules (still fully local)
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- websockets

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const termWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => {
      wsClients.add(ws);
      ws.on('close', () => wsClients.delete(ws));
      try { ws.send(JSON.stringify(snapshot())); } catch {}
    });
  } else if (pathname === '/term') {
    termWss.handleUpgrade(req, socket, head, ws => attachTerminal(ws, req));
  } else {
    socket.destroy();
  }
});

function attachTerminal(ws, req) {
  const target = new URL(req.url, 'http://localhost').searchParams.get('target');
  const fail = (msg) => { try { ws.send(JSON.stringify({ type: 'error', message: msg })); ws.close(); } catch {} };
  if (!target || !/^cc-[\w.-]+$/.test(target)) return fail('bad tmux target');
  if (!tmuxSessions.has(target)) return fail('tmux session not found — launch it with cc');
  let pty;
  try { pty = require('node-pty'); } catch { return fail('node-pty unavailable'); }
  let proc;
  try {
    proc = pty.spawn(TMUX_BIN, ['attach-session', '-t', target], {
      name: 'xterm-256color', cols: 120, rows: 32,
      cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (e) { return fail('tmux attach failed: ' + e.message); }
  proc.onData(d => { try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch {} });
  proc.onExit(() => { try { ws.close(); } catch {} });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'input' && typeof m.data === 'string') proc.write(m.data);
    if (m.type === 'resize' && m.cols && m.rows) { try { proc.resize(m.cols, m.rows); } catch {} }
  });
  ws.on('close', () => { try { proc.kill(); } catch {} });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Clawd Deck running at http://localhost:${PORT}`);
});
