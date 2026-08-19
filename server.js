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
// LaunchAgents get a minimal PATH, so resolve binaries explicitly
const TMUX_BIN = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']
  .find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'tmux';
// Wheel-up always scrolls tmux history (readable, no selection highlight) instead
// of being passed to claude, which treats it as prompt-history cycling. Wheel-down
// while live is swallowed for the same reason; inside the history view it scrolls
// down and drops back to live at the bottom. True full-screen apps
// (alternate_on) still get their mouse events. Server-wide, idempotent.
const TMUX_WHEEL_BINDINGS = [
  ';', 'bind-key', '-T', 'root', 'WheelUpPane',
  'if-shell', '-F', '-t', '=', '#{alternate_on}', 'send-keys -M', 'copy-mode -e ; send-keys -M',
  ';', 'bind-key', '-T', 'root', 'WheelDownPane',
  'if-shell', '-F', '-t', '=', '#{alternate_on}', 'send-keys -M', '',
  // Page Up scrolls history too (fn+↑ on a Mac keyboard) — a keyboard path that
  // needs no scroll device and no scrollbar; Page Down / reaching the bottom returns to live
  ';', 'bind-key', '-T', 'root', 'PPage',
  'if-shell', '-F', '#{alternate_on}', 'send-keys PPage', 'copy-mode -eu',
  // tmux strips OSC 8 hyperlinks (claude's linked text) unless the client
  // terminal declares support — xterm.js supports them. Indexed set = idempotent.
  ';', 'set-option', '-s', 'terminal-features[42]', 'xterm-256color:hyperlinks',
];
const CLAUDE_BIN = [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  .find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'claude';
const CONTEXT_WINDOW = 1_000_000; // claude-fable-5[1m]
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PROFILES_FILE = path.join(__dirname, 'profiles.json');
const ENDED_RETENTION_MS = 60 * 60 * 1000; // keep ended sessions on the board 1h

function expandHome(p) {
  return String(p).replace(/^~(?=\/|$)/, os.homedir());
}

// ---------------------------------------------------------------- state

// sessionId -> session record
const sessions = new Map();
const hiddenSessions = new Set(); // our own headless nudge runs — never shown as cards
const dismissed = new Set();      // ended cards the user closed; cleared if the session returns
// sessionId -> 'interactive' | 'machinery'. Claude spawns sessions of its own —
// background agents (kind "background", claimed from the bg-spare daemon pool)
// and headless `claude -p` runs (reported as kind "interactive", but with no
// controlling terminal). Both fire the same hooks as a real session, so hooks
// alone would put them on the board as anonymous cards. The poller classifies
// every id it sees; the snapshot keeps machinery off the board.
const sessionKinds = new Map();
let tmuxSessions = new Set(); // names of live tmux sessions ("cc-foo")
let tmuxPanes = new Map();    // tmux session name -> { cmd, cwd } of its first pane
let prs = { mine: [], needsMe: [], error: null, updatedAt: 0 };
let config = { autoNudge: false, titles: {} };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
config.titles = config.titles || {}; // sessionId -> { custom?, generated? }

function saveConfig() {
  // config.json is machine-written cache (titles, toggles). Account profiles live
  // in profiles.json, which is yours to edit and which this server never writes —
  // strip any legacy copies so a save can't resurrect them.
  const { profiles, mainLabel, ...machine } = config;
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(machine, null, 2)); } catch {}
}

// One-time migration: profiles used to live in config.json, where every cached
// title write clobbered hand edits. Move them to their own file once.
if (!fs.existsSync(PROFILES_FILE) && (config.profiles || config.mainLabel)) {
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify({
      main: { label: config.mainLabel || 'main' },
      profiles: (config.profiles || []).map(p => ({ id: p.id, label: p.label || p.id, dir: p.dir })),
    }, null, 2));
    saveConfig();
  } catch {}
}

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      sessionId: id,
      profileId: 'main',
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
      firstSeenAt: Date.now(),
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
  const prof = profilesCache.find(p => p.id === s.profileId);
  return {
    sessionId: s.sessionId,
    name: t.custom || t.generated || s.name,
    rawName: s.name,
    account: (prof && prof.email) || null,
    accountLabel: (prof && prof.label) || s.profileId,
    profileId: s.profileId,
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
    killable: !!((s.name && tmuxSessions.has('cc-' + s.name)) || s.pid),
    nudge: s.nudge,
  };
}

// ---------------------------------------------------------------- broadcast

const wsClients = new Set();
let broadcastTimer = null;

// A cc-* tmux pane running claude with no registered agent session is a session
// mid-startup — or parked on an interactive screen (login, trust prompt, wizard).
// Surface it as a "starting" card so it's a thing you can open and type into,
// never an invisible window that "never opened".
function syntheticTmuxSessions(claimed) {
  const out = [];
  for (const [t, info] of tmuxPanes) {
    if (!t.startsWith('cc-') || claimed.has(t)) continue;
    // claude's process name is its version-numbered binary ("2.1.234"); a pane
    // showing a plain shell means claude exited there — not a session anymore
    if (!/^(claude|node|\d+\.\d+\.\S+)$/.test((info && info.cmd) || '')) continue;
    out.push({
      sessionId: 'tmux:' + t,
      name: t.slice(3), rawName: t.slice(3),
      account: null, accountLabel: null, profileId: null,
      subtitle: null, cwd: (info && info.cwd) || null, gitBranch: null,
      status: 'starting', waitingFor: null, notification: null, compacting: false,
      alive: true, startedAt: null, endedAt: null, lastActivityAt: 0,
      todos: null, contextTokens: null, contextPct: null, model: null,
      artifactCount: 0, embeddable: true, tmuxTarget: t, killable: true, nudge: null,
    });
  }
  return out;
}

// Fingerprint of the UI files, sent with every snapshot: a parked dashboard
// tab reloads itself when the code on disk moves on, instead of silently
// running last week's page.
let staticVersion = '0';
try {
  const pub = path.join(__dirname, 'public');
  staticVersion = String(Math.max(...fs.readdirSync(pub).map(f => {
    try { return fs.statSync(path.join(pub, f)).mtimeMs; } catch { return 0; }
  })));
} catch {}

function snapshot() {
  const list = [...sessions.values()]
    .filter(s => !hiddenSessions.has(s.sessionId) && !dismissed.has(s.sessionId))
    .filter(s => sessionKinds.get(s.sessionId) !== 'machinery')
    .filter(s => {
      if (sessionKinds.get(s.sessionId) === 'interactive') {
        return s.alive || (s.endedAt && Date.now() - s.endedAt < ENDED_RETENTION_MS);
      }
      // hook-only, never confirmed as a real terminal session by the poller:
      // a genuine session gets confirmed within ~3s, so anything still
      // unconfirmed after a minute is a session from an unregistered profile
      // (show it) — while short-lived spawned runs never make it to the board,
      // and leave no "ended" corpse when they finish
      return s.alive && Date.now() - s.firstSeenAt > 60000;
    })
    .map(publicSession);
  // every tmux target any known session ever claimed, visible or not, so a
  // dismissed or just-ended session can't come back as a phantom "starting" card
  const claimed = new Set();
  for (const s of sessions.values()) if (s.name) claimed.add('cc-' + s.name);
  list.push(...syntheticTmuxSessions(claimed));
  list.sort((a, b) => {
    const rank = st => (st === 'waiting' ? 0 : st === 'ready' ? 1 : st === 'working' ? 2 :
      st === 'starting' ? 3 : st === 'idle' ? 4 : 5);
    return rank(a.status) - rank(b.status) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
  });
  return {
    type: 'snapshot', sessions: list, prs, config,
    appVersion: staticVersion,
    recentDirs: cachedRecentDirs,
    home: os.homedir(),
    profiles: profilesCache.map(p => ({ id: p.id, label: p.label, email: p.email, hasToken: !!p.token })),
    now: Date.now(),
  };
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

// ---- account profiles ----
// Each Claude account gets its own config directory (CLAUDE_CONFIG_DIR).
// 'main' is the default ~/.claude login; extras come from profiles.json:
//   { "main": { "label": "home" },
//     "profiles": [{ "id": "work", "label": "work", "dir": "~/.claude-profiles/work" }] }
// That file is yours to edit; the server watches it and never writes it.
function readAccountEmail(dir) {
  const f = dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  try { return (JSON.parse(fs.readFileSync(f, 'utf8')).oauthAccount || {}).emailAddress || null; }
  catch { return null; }
}

// A brand-new config dir drops its first session into the first-run wizard
// (theme picker) — invisible inside a detached tmux pane, which reads as "the
// window never opened". Seed the dir with the main login's onboarding state so
// a fresh profile boots straight to the login screen instead.
function seedProfileDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, '.claude.json');
    if (fs.existsSync(f)) return;
    let main = {};
    try { main = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); } catch {}
    const seed = { hasCompletedOnboarding: true };
    for (const k of ['theme', 'lastOnboardingVersion', 'installMethod', 'autoUpdates']) {
      if (main[k] !== undefined) seed[k] = main[k];
    }
    fs.writeFileSync(f, JSON.stringify(seed, null, 2));
    // a brand-new profile counts as a first-use-after-May-2026 account, which
    // defaults to the fullscreen renderer — no terminal scrollback. Opt out so
    // sessions scroll like a normal terminal (see docs: fullscreen rendering).
    const sf = path.join(dir, 'settings.json');
    if (!fs.existsSync(sf)) {
      fs.writeFileSync(sf, JSON.stringify(
        { env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' } }, null, 2));
    }
  } catch {}
}

let profilesCache = [{ id: 'main', dir: null, email: null, label: 'main', token: null }];
function refreshProfiles() {
  let spec = {};
  try { spec = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch {}
  const profs = [{ id: 'main', dir: null, label: (spec.main && spec.main.label) || 'main' },
    ...(spec.profiles || [])
      .filter(p => p && p.id && p.id !== 'main' && p.dir)
      .map(p => ({ id: p.id, label: p.label || p.id, dir: expandHome(p.dir) }))];
  for (const p of profs) {
    if (p.dir) seedProfileDir(p.dir);
    p.email = readAccountEmail(p.dir);
    // a long-lived token (from `claude setup-token`) saved as {dir}/token pins
    // this profile to its own account, independent of the shared macOS keychain
    p.token = null;
    if (p.dir) {
      try {
        const t = fs.readFileSync(path.join(p.dir, 'token'), 'utf8').trim();
        if (t) p.token = t;
      } catch {}
    }
  }
  profilesCache = profs;
}
refreshProfiles();
setInterval(refreshProfiles, 15000); // picks up a just-completed login quickly
fs.watchFile(PROFILES_FILE, { interval: 3000 }, () => { refreshProfiles(); broadcast(); });

function profileEnv(prof) {
  const env = { ...process.env };
  if (prof && prof.dir) env.CLAUDE_CONFIG_DIR = prof.dir;
  if (prof && prof.token) env.CLAUDE_CODE_OAUTH_TOKEN = prof.token;
  return env;
}

function profileEnvFor(s) {
  return profileEnv(profilesCache.find(x => x.id === (s && s.profileId)));
}

function pollAgents() {
  for (const prof of profilesCache) pollAgentsForProfile(prof);
  execFile(TMUX_BIN, ['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_command}\t#{pane_current_path}'],
    { timeout: 5000 }, (err, stdout) => {
      const names = new Set();
      const panes = new Map();
      if (!err) {
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const [name, cmd, cwd] = line.split('\t');
          names.add(name);
          if (!panes.has(name)) panes.set(name, { cmd, cwd });
        }
      }
      tmuxSessions = names;
      tmuxPanes = panes;
    });
}

function pollAgentsForProfile(prof) {
  execFile(CLAUDE_BIN, ['agents', '--json'], { timeout: 10000, env: profileEnv(prof) }, (err, stdout) => {
    if (err) return; // claude busy, missing, or profile not logged in — keep last known state
    let list;
    try { list = JSON.parse(stdout); } catch { return; }
    if (!Array.isArray(list)) return;
    // Headless `claude -p` runs report kind "interactive" too; the reliable tell
    // is the controlling terminal. A session you can open and type into always
    // sits on a pty (tmux allocates one even detached) — machinery shows "??".
    const pids = list.filter(a => a && a.pid).map(a => a.pid);
    execFile('ps', ['-o', 'pid=,tty=', '-p', pids.join(',') || '0'], { timeout: 5000 }, (psErr, psOut) => {
      const ttys = new Map();
      if (!psErr) {
        for (const line of String(psOut || '').split('\n')) {
          const m = line.trim().split(/\s+/);
          if (m.length >= 2) ttys.set(Number(m[0]), m[1]);
        }
      }
      classifyAndIngest(prof, list, ttys);
    });
  });
}

function classifyAndIngest(prof, list, ttys) {
  const seen = new Set();
  for (const a of list) {
    if (!a || !a.sessionId) continue;
    const tty = ttys.get(a.pid);
    if (a.kind !== 'interactive' || tty === '??') {
      sessionKinds.set(a.sessionId, 'machinery');
      continue;
    }
    // no ps data (ps failed, or pid gone between calls): don't overwrite an
    // earlier machinery verdict, but give an unknown id the benefit of the doubt
    if (tty || !sessionKinds.has(a.sessionId)) sessionKinds.set(a.sessionId, 'interactive');
    if (sessionKinds.get(a.sessionId) !== 'interactive') continue;
    seen.add(a.sessionId);
    dismissed.delete(a.sessionId);
    const s = getSession(a.sessionId);
    s.profileId = prof.id;
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
    // only this profile's poller may declare its own sessions dead
    if (s.alive && s.profileId === prof.id && s.agentStatus !== null && !seen.has(s.sessionId)) {
      s.alive = false;
      if (!s.endedAt) s.endedAt = Date.now();
    }
  }
  broadcast();
}
setInterval(pollAgents, 3000);
pollAgents();

// profile-independent sweeps: hook-only sessions expire by inactivity, and
// READY that sat unread for 30 min fades to idle so a morning board isn't all blue
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.alive && s.agentStatus === null &&
        s.lastActivityAt && now - s.lastActivityAt > 10 * 60 * 1000) {
      s.alive = false;
      if (!s.endedAt) s.endedAt = s.lastActivityAt;
    }
    if (s.hookStatus === 'ready' && now - s.hookStatusAt > 30 * 60 * 1000) {
      s.hookStatus = 'idle';
    }
  }
  broadcast();
}, 15000);

// ---------------------------------------------------------------- history.jsonl (titles)

const historyBySession = new Map(); // sessionId -> { firstPrompt, project, lastTs }
const recentProjects = new Map();   // project dir -> last prompt timestamp
let cachedRecentDirs = [];
const historyOffsets = new Map();   // history file path -> bytes already read

function attachSubtitle(s) {
  if (s.subtitle) return;
  const h = historyBySession.get(s.sessionId);
  if (h) s.subtitle = String(h.firstPrompt).slice(0, 140);
}

function historyFiles() {
  const files = [HISTORY_FILE];
  for (const p of profilesCache) if (p.dir) files.push(path.join(p.dir, 'history.jsonl'));
  return files;
}

function ingestHistory() {
  for (const file of historyFiles()) {
    let fd;
    try {
      const size = fs.statSync(file).size;
      let offset = historyOffsets.get(file) || 0;
      if (size < offset) offset = 0; // rotated
      if (size === offset) continue;
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      historyOffsets.set(file, size);
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
        if (e.project) recentProjects.set(e.project, e.timestamp || 0);
      }
    } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  cachedRecentDirs = [...recentProjects.entries()]
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .map(e => e[0])
    .filter(p => { try { return fs.existsSync(p); } catch { return false; } })
    .slice(0, 15);
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
  const roots = [PROJECTS_DIR];
  for (const p of profilesCache) if (p.dir) roots.push(path.join(p.dir, 'projects'));
  const dirs = [];
  for (const root of roots) {
    try {
      for (const d of fs.readdirSync(root)) {
        const full = path.join(root, d);
        try { if (fs.statSync(full).isDirectory()) dirs.push(full); } catch {}
      }
    } catch {}
  }
  projectDirs = dirs;
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
    if (!s.alive || sessionKinds.get(s.sessionId) === 'machinery') continue;
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
  for (const s of sessions.values()) {
    if (s.alive && sessionKinds.get(s.sessionId) !== 'machinery') scanArtifacts(s);
  }
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
  const child = spawn(CLAUDE_BIN, ['-p', '--model', 'haiku', '--session-id', hid, prompt],
    { cwd: os.homedir(), timeout: 60000, env: profileEnvFor(s) });
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
  const child = spawn(CLAUDE_BIN,
    ['-p', '--session-id', nudgeId, '--permission-mode', 'acceptEdits', prompt],
    { cwd, timeout: 5 * 60 * 1000, env: profileEnvFor(s) });
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
  if (b.transcript_path) {
    s.transcriptPath = b.transcript_path;
    // a transcript under a profile's directory tells us which account this is
    for (const p of profilesCache) {
      if (p.dir && b.transcript_path.startsWith(p.dir + path.sep)) { s.profileId = p.id; break; }
    }
  }
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

// List the subfolders of a directory for the New session folder picker.
app.get('/api/browse', (req, res) => {
  let p = expandHome(String(req.query.path || '').trim());
  if (!p) p = os.homedir();
  p = path.resolve(p);
  try {
    if (!fs.statSync(p).isDirectory()) p = path.dirname(p);
  } catch {
    // walk up to the nearest folder that exists, so typing a path browses as you go
    let up = path.dirname(p);
    while (up !== path.dirname(up) && !fs.existsSync(up)) up = path.dirname(up);
    p = fs.existsSync(up) ? up : os.homedir();
  }
  let dirs = [];
  let error = null;
  try {
    dirs = fs.readdirSync(p, { withFileTypes: true })
      .filter(d => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.') && d.name !== 'node_modules')
      .filter(d => { try { return fs.statSync(path.join(p, d.name)).isDirectory(); } catch { return false; } })
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 400);
  } catch (e) { error = 'cannot read this folder'; }
  res.json({ path: p, parent: p === path.dirname(p) ? null : path.dirname(p), dirs, error });
});

// Client-side diagnostics land in this server's log, so a "doesn't work on my
// machine" report comes with the failing layer named.
app.post('/api/client-log', (req, res) => {
  console.log('[client]', String((req.body || {}).msg || '').slice(0, 300));
  res.json({ ok: true });
});

// Start a new Claude session inside tmux, embeddable from the browser.
app.post('/api/new-session', (req, res) => {
  const name = String((req.body || {}).name || '').trim()
    .replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!name) return res.status(400).json({ error: 'give the session a name' });
  let cwd = String((req.body || {}).cwd || '').trim().replace(/^~(?=\/|$)/, os.homedir());
  if (!cwd) cwd = os.homedir();
  if (!fs.existsSync(cwd)) return res.status(400).json({ error: 'folder not found: ' + cwd });
  const target = 'cc-' + name;
  if (tmuxSessions.has(target)) return res.status(400).json({ error: 'a session named ' + name + ' is already running' });
  const prof = profilesCache.find(p => p.id === String((req.body || {}).profile || 'main')) || profilesCache[0];
  const args = ['new-session', '-d', '-s', target, '-c', cwd];
  // classic renderer for every launched session, whoever's machine this is:
  // claude's fullscreen default (accounts first used after May 2026) leaves the
  // terminal with no scrollback, which kills scrolling in the embedded view
  args.push('-e', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1');
  if (prof.dir) args.push('-e', 'CLAUDE_CONFIG_DIR=' + prof.dir);
  if (prof.token) args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=' + prof.token);
  args.push(CLAUDE_BIN, '-n', name);
  // mouse on: wheel scrolling reaches tmux (copy-mode history) or the app,
  // so the embedded terminal can scroll instead of being a fixed screen
  args.push(';', 'set-option', '-t', target, 'mouse', 'on', ...TMUX_WHEEL_BINDINGS);
  execFile(TMUX_BIN, args,
    { timeout: 10000 }, (err) => {
      if (err) return res.status(500).json({ error: String(err.message || err).split('\n')[0] });
      tmuxSessions.add(target);
      tmuxPanes.set(target, { cmd: 'claude', cwd }); // visible as "starting" right away
      broadcast();
      setTimeout(pollAgents, 700);
      res.json({ ok: true, name, target });
    });
});

// Actually end a session: kill its tmux session (which takes claude with it),
// or SIGTERM the claude process for sessions running in a plain terminal tab.
// The card is dismissed optimistically; if the process survives, the next
// agents poll sees it alive and puts the card straight back.
app.post('/api/session/:id/kill', (req, res) => {
  const id = req.params.id;
  const finish = () => {
    broadcast();
    setTimeout(pollAgents, 1200); // verify the kill took
    res.json({ ok: true });
  };
  const killTmux = (target) => {
    execFile(TMUX_BIN, ['kill-session', '-t', target], { timeout: 5000 }, () => {
      tmuxSessions.delete(target);
      tmuxPanes.delete(target);
      finish();
    });
  };
  if (id.startsWith('tmux:')) { // synthetic "starting" card
    const target = id.slice(5);
    if (!/^cc-[\w.-]+$/.test(target)) return res.status(400).json({ error: 'bad tmux target' });
    return killTmux(target);
  }
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'unknown session' });
  dismissed.add(id);
  s.alive = false;
  s.endedAt = Date.now();
  s.hookStatus = 'ended';
  s.hookStatusAt = Date.now();
  const target = s.name && tmuxSessions.has('cc-' + s.name) ? 'cc-' + s.name : null;
  if (target) return killTmux(target);
  if (s.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  finish();
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

// static UI + vendored xterm straight out of node_modules (still fully local).
// no-cache = browsers must revalidate every file on every load, so a reload
// can never pair fresh HTML with a stale cached app.js (cheap on localhost).
const noStale = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm'), noStale));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit'), noStale));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links'), noStale));
app.use(express.static(path.join(__dirname, 'public'), noStale));

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
  // sessions created before these options existed (or by older cc) get them on attach
  execFile(TMUX_BIN, ['set-option', '-t', target, 'mouse', 'on',
    ...TMUX_WHEEL_BINDINGS], { timeout: 3000 }, () => {});
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

  // Scrollbar support: report where the pane sits in its history once a second,
  // and jump to requested positions. pos counts lines above live (0 = live).
  let lastScroll = { history: 0, pos: 0, rows: 0 };
  const scrollPoll = setInterval(() => {
    execFile(TMUX_BIN, ['display-message', '-p', '-t', target,
      '#{history_size}\t#{scroll_position}\t#{pane_height}\t#{alternate_on}'], { timeout: 2000 }, (err, out) => {
      if (err || !out) return;
      const [h, p, r, a] = out.trim().split('\t');
      lastScroll = { history: +h || 0, pos: +p || 0, rows: +r || 0, alt: +a || 0 };
      try { ws.send(JSON.stringify({ type: 'scroll', ...lastScroll })); } catch {}
    });
  }, 1000);

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'input' && typeof m.data === 'string') proc.write(m.data);
    if (m.type === 'resize' && m.cols && m.rows) { try { proc.resize(m.cols, m.rows); } catch {} }
    // full-screen claude UI (alternate screen): scrolling is internal to claude,
    // driven by PageUp/PageDown — the scrollbar pages instead of positioning
    if (m.type === 'page' && lastScroll.alt) {
      if (m.dir === 'up' || m.dir === 'down') {
        execFile(TMUX_BIN, ['send-keys', '-t', target, m.dir === 'up' ? 'PPage' : 'NPage'],
          { timeout: 2000 }, () => {});
      } else if (m.dir === 'bottom') {
        execFile(TMUX_BIN, ['send-keys', '-t', target,
          'NPage', 'NPage', 'NPage', 'NPage', 'NPage', 'NPage', 'NPage', 'NPage', 'NPage', 'NPage'],
          { timeout: 2000 }, () => {});
      }
    }
    if (m.type === 'scrollTo' && typeof m.pos === 'number') {
      const want = Math.max(0, Math.min(Math.round(m.pos), lastScroll.history));
      if (want === 0) {
        execFile(TMUX_BIN, ['send-keys', '-X', '-t', target, 'cancel'], { timeout: 2000 }, () => {});
      } else {
        const delta = want - lastScroll.pos;
        if (delta > 0) {
          execFile(TMUX_BIN, ['copy-mode', '-e', '-t', target, ';',
            'send-keys', '-X', '-N', String(delta), '-t', target, 'scroll-up'], { timeout: 2000 }, () => {});
        } else if (delta < 0) {
          execFile(TMUX_BIN, ['send-keys', '-X', '-N', String(-delta), '-t', target, 'scroll-down'],
            { timeout: 2000 }, () => {});
        }
      }
      lastScroll.pos = want; // optimistic; the poll corrects any drift
    }
  });
  ws.on('close', () => { clearInterval(scrollPoll); try { proc.kill(); } catch {} });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Clawd Deck running at http://localhost:${PORT}`);
});
