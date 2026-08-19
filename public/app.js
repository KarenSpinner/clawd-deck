/* Clawd Deck client. Live over WebSocket, no framework. */

let state = { sessions: [], prs: { mine: [], needsMe: [] }, config: {} };
let detailSessionId = null;
let pendingSession = null; // a session we just launched, shown before any snapshot carries it
let term = null, termWs = null, fitAddon = null;
let sortMode = localStorage.getItem('deckSort') || 'attention'; // read before first render

// ---------------------------------------------------------------- helpers

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortPath(p) {
  if (!p) return '';
  return p.replace(/^\/Users\/[^/]+/, '~');
}

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  return Math.round(m / 60) + 'h';
}

function copyBtn(text, label = 'copy') {
  const b = document.createElement('button');
  b.className = 'copy-btn';
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      b.textContent = 'copied ✓'; b.classList.add('copied');
      setTimeout(() => { b.textContent = label; b.classList.remove('copied'); }, 1400);
    });
  });
  return b;
}

// Minimal markdown → DOM. Escapes everything first; fenced code blocks get
// their own copy buttons carrying the raw, unwrapped text.
function renderMarkdown(text, container) {
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // code block: first line may be a language tag
      const nl = part.indexOf('\n');
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      const wrap = document.createElement('div');
      wrap.className = 'codeblock';
      const pre = document.createElement('pre');
      pre.textContent = code.replace(/\n$/, '');
      wrap.appendChild(pre);
      wrap.appendChild(copyBtn(code.replace(/\n$/, '')));
      container.appendChild(wrap);
    } else if (part.trim()) {
      const div = document.createElement('div');
      let html = esc(part);
      html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>');
      html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>[\s\S]*?<\/li>)(\n(?!<li>)|$)/g, '<ul>$1</ul>$2');
      html = html.split(/\n{2,}/).map(chunk =>
        /^<(h\d|ul|ol)/.test(chunk.trim()) ? chunk : '<p>' + chunk.replace(/\n/g, '<br>') + '</p>'
      ).join('');
      div.innerHTML = html;
      container.appendChild(div);
    }
  });
}

// ---------------------------------------------------------------- theme

// Full palettes for the embedded terminal: xterm's default ANSI colors are
// picked for a dark background and turn unreadable on white, so light mode
// gets an explicit set (GitHub-light-ish).
const TERM_THEMES = {
  dark: {
    background: '#000000', foreground: '#e6e6e6',
    cursor: '#e6e6e6', cursorAccent: '#000000', selectionBackground: '#58a6ff55',
    black: '#000000', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
    brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
  },
  light: {
    background: '#ffffff', foreground: '#24292f',
    cursor: '#24292f', cursorAccent: '#ffffff', selectionBackground: '#b6d8fd',
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00',
    blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01',
    brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
};

function themeMode() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function applyTheme(mode) {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  localStorage.setItem('deckTheme', mode);
  const b = $('#themeToggle');
  b.textContent = mode === 'dark' ? '☀ light' : '☾ dark';
  if (term) term.options.theme = TERM_THEMES[mode]; // restyle a live terminal in place
  if (state.sessions) renderGrid();                 // account chips tint per theme
}
$('#themeToggle').addEventListener('click', () => applyTheme(themeMode() === 'dark' ? 'light' : 'dark'));
applyTheme(themeMode());

// ---------------------------------------------------------------- grid

function sortSessions(list) {
  const rank = st => (st === 'waiting' ? 0 : st === 'ready' ? 1 : st === 'working' ? 2 :
    st === 'starting' ? 3 : st === 'idle' ? 4 : 5);
  const copy = [...list];
  if (sortMode === 'name') copy.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  else if (sortMode === 'activity') copy.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  else if (sortMode === 'context') copy.sort((a, b) => (b.contextPct || 0) - (a.contextPct || 0));
  else copy.sort((a, b) => rank(a.status) - rank(b.status) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return copy;
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  if (!state.sessions.length) {
    grid.innerHTML = '<div class="empty">No sessions yet. Open a Claude Code tab and it will show up here on its own.</div>';
  }
  for (const s of sortSessions(state.sessions)) {
    const card = document.createElement('div');
    card.className = 'card ' + s.status;
    card.addEventListener('click', () => openDetail(s.sessionId));

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const fullName = s.name || s.sessionId.slice(0, 8);
    const nameTip = fullName + (s.rawName && s.rawName !== s.name ? ' (session: ' + s.rawName + ')' : '');
    row1.innerHTML = `<span class="dot ${esc(s.status)}"></span>
      <span class="name" title="${esc(nameTip)}">${esc(fullName)}</span>`;
    if (s.status === 'waiting') {
      const b = document.createElement('span');
      b.className = 'badge needs-you';
      b.textContent = 'NEEDS YOU';
      b.title = s.notification || s.waitingFor || '';
      row1.appendChild(b);
    } else if (s.status === 'ready') {
      const b = document.createElement('span');
      b.className = 'badge ready';
      b.textContent = 'READY';
      b.title = s.notification || 'Finished and waiting for your next prompt';
      row1.appendChild(b);
    } else if (s.status === 'starting') {
      const b = document.createElement('span');
      b.className = 'badge starting';
      b.textContent = 'STARTING';
      b.title = 'Launched but not on the board yet. Click to watch it come up — if it is sitting on a sign-in or setup screen, you can type into it here.';
      row1.appendChild(b);
    } else if (s.compacting) {
      const b = document.createElement('span');
      b.className = 'badge compacting';
      b.textContent = 'COMPACTING';
      row1.appendChild(b);
    } else {
      // quiet states carry their word too: from a second monitor, "WORKING"
      // vs "IDLE" reads instantly where a colored dot is a guess
      const b = document.createElement('span');
      b.className = 'badge ' + esc(s.status);
      b.textContent = s.status.toUpperCase();
      b.title = s.status === 'working' ? 'Mid-turn, no input needed'
        : s.status === 'idle' ? 'Nothing happening right now'
        : s.status === 'ended' ? 'This session is over' : '';
      row1.appendChild(b);
      if (s.status === 'ended') {
        const x = document.createElement('button');
        x.className = 'dismiss-btn';
        x.textContent = '×';
        x.title = 'Remove this card';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          fetch(`/api/session/${s.sessionId}/dismiss`, { method: 'POST' });
        });
        row1.appendChild(x);
      }
    }
    card.appendChild(row1);

    if (s.subtitle) {
      const sub = document.createElement('div');
      sub.className = 'subtitle';
      sub.textContent = s.subtitle;
      card.appendChild(sub);
    }

    // no branch chip here: branch names are long, rarely needed at a glance,
    // and steal the copy's room — the session view's header still shows ⎇ branch
    const chips = document.createElement('div');
    chips.className = 'chips';
    if (s.cwd) chips.innerHTML += `<span class="chip" title="${esc(s.cwd)}">${esc(shortPath(s.cwd))}</span>`;
    if ((state.profiles || []).length > 1 && s.accountLabel) {
      const hue = [...String(s.accountLabel)].reduce((a, c) => a + c.charCodeAt(0) * 37, 0) % 360;
      const tip = 'Account: ' + s.accountLabel + '. ' + (s.profileId === 'main'
        ? 'Shared main login, currently ' + (s.account || 'unknown') + '. Running /login in any main session switches all of them.'
        : (s.account || 'own login, separate from the main one'));
      const tint = themeMode() === 'dark'
        ? `color:hsl(${hue},65%,78%);border-color:hsl(${hue},35%,38%);background:hsl(${hue},40%,17%)`
        : `color:hsl(${hue},55%,30%);border-color:hsl(${hue},40%,72%);background:hsl(${hue},50%,96%)`;
      chips.innerHTML += `<span class="chip account" title="${esc(tip)}" style="${tint}">@ ${esc(s.accountLabel)}</span>`;
    }
    card.appendChild(chips);

    if (s.todos && s.todos.length) {
      const open = s.todos.filter(t => t.status !== 'completed');
      const box = document.createElement('div');
      box.className = 'todos';
      const show = [...s.todos.filter(t => t.status === 'in_progress'),
                    ...s.todos.filter(t => t.status === 'pending'),
                    ...s.todos.filter(t => t.status === 'completed')].slice(0, 4);
      for (const t of show) {
        const d = document.createElement('div');
        d.className = 't ' + esc(t.status);
        d.textContent = t.content;
        box.appendChild(d);
      }
      if (s.todos.length > 4) {
        const more = document.createElement('div');
        more.className = 't pending';
        more.textContent = `… ${open.length} open of ${s.todos.length}`;
        box.appendChild(more);
      }
      card.appendChild(box);
    }

    // card footer, pinned to the bottom edge of every card: the context gauge,
    // one meta row (context numbers on the left, the files link on the right),
    // then the buttons — so nothing floats and the copy above keeps its room
    const foot = document.createElement('div');
    foot.className = 'foot';
    if (typeof s.contextPct === 'number') {
      const g = document.createElement('div');
      g.className = 'gauge' + (s.contextPct > 85 ? ' crit' : s.contextPct > 60 ? ' hot' : '');
      g.innerHTML = `<div style="width:${Math.max(1, s.contextPct)}%"></div>`;
      foot.appendChild(g);
    }
    if (typeof s.contextPct === 'number' || s.artifactCount) {
      const meta = document.createElement('div');
      meta.className = 'meta-row';
      if (typeof s.contextPct === 'number') {
        const gl = document.createElement('div');
        gl.className = 'gauge-label';
        gl.textContent = `context ${s.contextPct}%` +
          (s.contextTokens ? ` · ${Math.round(s.contextTokens / 1000)}k` : '') +
          (s.lastActivityAt ? ` · active ${ago(s.lastActivityAt)}` : '');
        meta.appendChild(gl);
      }
      const msp = document.createElement('span');
      msp.className = 'spacer';
      meta.appendChild(msp);
      if (s.artifactCount) {
        const a = document.createElement('button');
        a.className = 'artifact-count';
        a.textContent = `📄 ${s.artifactCount} file${s.artifactCount === 1 ? '' : 's'}`;
        a.title = 'Show what this session produced, in the Artifacts panel';
        a.addEventListener('click', (e) => {
          e.stopPropagation();
          openArtifactsFor(s.sessionId);
        });
        meta.appendChild(a);
      }
      foot.appendChild(meta);
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (s.nudge) {
      const n = document.createElement('span');
      n.className = 'nudge-note';
      n.textContent = s.nudge.state === 'running' ? 'memory: updating…'
        : s.nudge.state === 'done' ? 'memory ✓' : 'memory ✗';
      n.title = s.nudge.summary || '';
      actions.appendChild(n);
    }
    // never innerHTML+= here: re-parsing the row would strip the listeners
    // off the buttons already appended (the file chip lost its click this way)
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    actions.appendChild(spacer);
    const ren = document.createElement('button');
    ren.className = 'mini';
    ren.textContent = 'rename';
    ren.title = 'Rename this card. The session itself keeps its own name.';
    ren.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = window.prompt('Title for this session (leave empty to reset):', s.name || '');
      if (v === null) return;
      fetch(`/api/session/${s.sessionId}/title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: v }),
      });
    });
    actions.appendChild(ren);
    const mem = document.createElement('button');
    mem.className = 'mini';
    mem.textContent = 'update memory';
    mem.disabled = s.nudge && s.nudge.state === 'running';
    mem.title = 'Asks a background Claude to read this session and save anything worth remembering. Costs one short run.';
    mem.addEventListener('click', (e) => {
      e.stopPropagation();
      fetch(`/api/session/${s.sessionId}/memory-nudge`, { method: 'POST' });
    });
    actions.appendChild(mem);
    if (s.killable && s.status !== 'ended') {
      const kill = document.createElement('button');
      kill.className = 'mini kill';
      kill.textContent = 'kill';
      kill.title = 'End this session for real — closes its Claude process (and tmux window). ' +
        'Use × on the ended card afterwards to clear it.';
      kill.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!window.confirm(`End the session "${s.name || s.sessionId.slice(0, 8)}"? ` +
          'Its Claude process exits and anything unfinished there stops.')) return;
        kill.disabled = true;
        kill.textContent = 'killing…';
        fetch(`/api/session/${s.sessionId}/kill`, { method: 'POST' });
      });
      actions.appendChild(kill);
    }
    foot.appendChild(actions);
    card.appendChild(foot);

    grid.appendChild(card);
  }

  const waiting = state.sessions.filter(s => s.status === 'waiting').length;
  const ready = state.sessions.filter(s => s.status === 'ready').length;
  const working = state.sessions.filter(s => s.status === 'working').length;
  const ended = state.sessions.filter(s => s.status === 'ended').length;
  const live = state.sessions.length - ended;
  $('#counts').innerHTML =
    `${live} session${live === 1 ? '' : 's'} · ${working} working` +
    (ready ? ` · <span class="readycount">${ready} ready</span>` : '') +
    (waiting ? ` · <span class="waitcount">${waiting} need${waiting === 1 ? 's' : ''} you</span>` : '') +
    (ended ? ` · <button class="linklike" id="clearEnded">clear ${ended} ended</button>` : '');
  const ce = $('#clearEnded');
  if (ce) ce.addEventListener('click', () => fetch('/api/dismiss-ended', { method: 'POST' }));
  $('#autoNudge').checked = !!state.config.autoNudge;
  document.title = (waiting ? `(${waiting}) ` : '') + 'Clawd Deck';
}

// ---------------------------------------------------------------- sidebar

// Rebuild a sidebar panel only when its content actually changed, and keep the
// user's scroll position when it does. Rebuilding on every snapshot emptied the
// panel for a moment, which snapped its scroll back to the top.
const sidebarKeys = { artifacts: null, prs: null };

function rebuildPanel(panel, keyName, key, build) {
  if (sidebarKeys[keyName] === key) return;
  sidebarKeys[keyName] = key;
  const scrollWas = panel.scrollTop;
  panel.innerHTML = '';
  build(panel);
  panel.scrollTop = scrollWas;
}

function renderSidebar() {
  rebuildPanel($('#tab-artifacts'), 'artifacts',
    JSON.stringify(state.sessions.map(s => [s.sessionId, s.name, s.artifactCount])), renderArtifactsPanel);
  rebuildPanel($('#tab-prs'), 'prs',
    JSON.stringify([state.prs.mine, state.prs.needsMe, state.prs.error]), renderPrsPanel);
}

// Jump the sidebar to one session's artifacts: open the panel if hidden,
// switch to the Artifacts tab, scroll to the session's group and flash it.
// The intent is remembered briefly, because a live snapshot can rebuild the
// panel right after the click and wipe a class set only once.
let artifactsFlash = { id: null, at: 0 };
function openArtifactsFor(sessionId) {
  artifactsFlash = { id: sessionId, at: Date.now() };
  if (document.body.classList.contains('no-sidebar')) {
    localStorage.setItem('deckSidebar', 'open');
    applySidebar();
  }
  const tabBtn = document.querySelector('.tabs button[data-tab="artifacts"]');
  if (tabBtn) tabBtn.click();
  const jump = () => {
    const g = document.querySelector(`#tab-artifacts .side-group[data-session-id="${sessionId}"]`);
    if (!g) return;
    g.scrollIntoView({ block: 'start', behavior: 'smooth' });
    g.classList.remove('flash');
    void g.offsetWidth; // restart the animation on repeat clicks
    g.classList.add('flash');
  };
  setTimeout(jump, 60);  // give the group's file list a beat to render
  setTimeout(jump, 700); // and land again if a snapshot rebuilt the panel
}

function renderArtifactsPanel(ap) {
  let anyArt = false;
  for (const s of state.sessions) {
    if (!s.artifactCount) continue;
    anyArt = true;
    const g = document.createElement('div');
    g.className = 'side-group';
    g.dataset.sessionId = s.sessionId;
    if (artifactsFlash.id === s.sessionId && Date.now() - artifactsFlash.at < 2500) {
      g.classList.add('flash'); // a rebuild mid-flash keeps the landing highlight
    }
    g.innerHTML = `<h4>${esc(s.name || s.sessionId.slice(0, 8))}</h4><div class="empty">loading…</div>`;
    ap.appendChild(g);
    fetch(`/api/session/${s.sessionId}/artifacts`).then(r => r.json()).then(art => {
      g.querySelector('.empty').remove();
      for (const u of art.urls || []) {
        const d = document.createElement('div');
        d.className = 'side-item';
        d.innerHTML = `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https:\/\//, ''))}</a>`;
        g.appendChild(d);
      }
      for (const f of art.files || []) {
        const d = document.createElement('div');
        d.className = 'side-item';
        d.innerHTML = `<span>📄</span><span>${esc(shortPath(f))}</span>`;
        d.appendChild(copyBtn(f, 'path'));
        g.appendChild(d);
      }
    }).catch(() => {});
  }
  if (!anyArt) ap.innerHTML = '<div class="empty">Nothing collected yet. Files and links your sessions produce will land here.</div>';
}

function renderPrsPanel(pp) {
  const prGroup = (title, list) => {
    const g = document.createElement('div');
    g.className = 'side-group';
    g.innerHTML = `<h4>${title}</h4>`;
    if (!list.length) g.innerHTML += '<div class="empty">none</div>';
    for (const pr of list) {
      const d = document.createElement('div');
      d.className = 'side-item';
      const ci = pr.ci ? `<span class="pr-status ${esc(pr.ci)}" title="CI ${esc(pr.ci)}">${pr.ci === 'SUCCESS' ? '✓' : pr.ci === 'PENDING' ? '●' : '✗'}</span>` : '<span class="pr-status">·</span>';
      const rev = pr.review ? `<span class="pr-review ${esc(pr.review)}">${esc(pr.review.replace('_', ' ').toLowerCase())}</span>` : '';
      d.innerHTML = `${ci}<a href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.repo)}#${pr.number} ${esc(pr.title)}</a>${rev}`;
      g.appendChild(d);
    }
    return g;
  };
  pp.appendChild(prGroup('Mine', state.prs.mine || []));
  pp.appendChild(prGroup('Needs me', state.prs.needsMe || []));
  if (state.prs.error) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'gh error: ' + state.prs.error;
    pp.appendChild(e);
  }
}

// ---------------------------------------------------------------- detail view

function openDetail(sessionId) {
  detailSessionId = sessionId;
  $('#detail').classList.remove('hidden');
  renderDetail(true);
}

function closeDetail() {
  detailSessionId = null;
  $('#detail').classList.add('hidden');
  disconnectTerm();
}
$('#detail-close').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailSessionId) closeDetail(); });

$('#detail-kill').addEventListener('click', () => {
  const s = findDetailSession();
  if (!s) return;
  if (!window.confirm(`End the session "${s.name || s.sessionId.slice(0, 8)}"? ` +
    'Its Claude process exits and anything unfinished there stops.')) return;
  fetch(`/api/session/${s.sessionId}/kill`, { method: 'POST' });
  closeDetail();
});

function findDetailSession() {
  return state.sessions.find(x => x.sessionId === detailSessionId) ||
    (pendingSession && pendingSession.sessionId === detailSessionId ? pendingSession : null);
}

function renderDetail(fresh) {
  const s = findDetailSession();
  if (!s) return;
  $('#detail-title').textContent = s.name || s.sessionId.slice(0, 8);
  $('#detail-meta').textContent =
    `${shortPath(s.cwd || '')}${s.gitBranch ? ' ⎇ ' + s.gitBranch : ''}` +
    `${typeof s.contextPct === 'number' ? ' · context ' + s.contextPct + '%' : ''} · ${s.status}`;
  $('#detail-kill').classList.toggle('hidden', !(s.killable && s.status !== 'ended'));
  if (fresh) {
    // embedded sessions open terminal-first; the conversation pane waits until
    // asked for (or until the user's last choice says otherwise)
    convoVisible = (s.embeddable && s.tmuxTarget)
      ? localStorage.getItem('deckConvo') === 'show'
      : true;
    connectTerm(s);
    applyConvoVisibility(s);
    if (convoVisible) {
      loadConversation(s.sessionId);
      convoActivityAt = s.lastActivityAt || 0;
    }
  } else {
    if (s.embeddable && s.tmuxTarget && !term) {
      // the session became embeddable after the card was opened (tmux poll lag)
      connectTerm(s);
      applyConvoVisibility(s);
    }
    // keep the conversation pane current while the session talks, so the
    // clean-copy text is never behind what the terminal shows
    if (convoVisible && s.lastActivityAt && s.lastActivityAt !== convoActivityAt) {
      convoActivityAt = s.lastActivityAt;
      loadConversation(s.sessionId, true);
    }
  }
}

let convoVisible = true;

function applyConvoVisibility(s) {
  const btn = $('#convo-toggle');
  if (s.embeddable && s.tmuxTarget) {
    btn.classList.remove('hidden');
    $('#term-font').classList.remove('hidden');
    btn.textContent = convoVisible ? 'hide copy-paste view' : 'copy-paste view';
    btn.title = 'The conversation as clean text, with a copy button on every message and code block';
    $('#convo-pane').classList.toggle('hidden', !convoVisible);
  } else {
    btn.classList.add('hidden');
    $('#term-font').classList.add('hidden');
    $('#convo-pane').classList.remove('hidden');
  }
  // the terminal reclaims or cedes width; refit after layout settles — twice,
  // because a fit against mid-transition geometry leaves the terminal sized
  // wrong (content not filling the pane) until something else nudges it
  for (const delay of [60, 400]) setTimeout(sendTermResize, delay);
}

// Refit the terminal and tell tmux. On fullscreen sessions a resize scrambles
// claude's internal scroll position (the view lands on an empty region with
// claude's own "Jump to bottom" hint showing), so follow up with a snap to live.
let altSnapTimer = null;
let lastTermSize = { cols: 0, rows: 0 };
function sendTermResize(force) {
  if (!term || !fitAddon) return;
  try {
    fitAddon.fit();
    // only a real size change goes to tmux — and after tmux reflows, park the
    // viewport on the live screen, or the session looks emptied (the text is
    // fine, the view just isn't looking at it)
    if (force === true || term.cols !== lastTermSize.cols || term.rows !== lastTermSize.rows) {
      lastTermSize = { cols: term.cols, rows: term.rows };
      if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      term.scrollToBottom();
    }
  } catch {}
  if (termScrollState.alt) {
    clearTimeout(altSnapTimer);
    altSnapTimer = setTimeout(() => {
      if (termScrollState.alt && termWs && termWs.readyState === 1) {
        termWs.send(JSON.stringify({ type: 'page', dir: 'bottom' }));
        altPageEstimate = 0;
        renderTermBar();
      }
    }, 400);
  }
}

$('#convo-toggle').addEventListener('click', () => {
  convoVisible = !convoVisible;
  localStorage.setItem('deckConvo', convoVisible ? 'show' : 'hide');
  const s = findDetailSession();
  if (!s) return;
  applyConvoVisibility(s);
  if (convoVisible) {
    loadConversation(s.sessionId);
    convoActivityAt = s.lastActivityAt || 0;
  }
});

let convoActivityAt = 0;

function loadConversation(sessionId, quiet) {
  const convo = $('#convo');
  if (String(sessionId).startsWith('tmux:')) {
    // still starting — there is no transcript to show yet
    convo.innerHTML = '<div class="empty">No conversation yet — the session is still starting. The terminal is live.</div>';
    return;
  }
  if (!quiet) convo.innerHTML = '<div class="empty">loading the conversation…</div>';
  fetch(`/api/session/${sessionId}/conversation`).then(r => r.json()).then(data => {
    if (sessionId !== detailSessionId) return;
    // on a quiet refresh, keep the reader's place unless they were at the bottom
    const nearBottom = convo.scrollHeight - convo.scrollTop - convo.clientHeight < 80;
    const scrollWas = convo.scrollTop;
    convo.innerHTML = '';
    if (!data.messages || !data.messages.length) {
      convo.innerHTML = '<div class="empty">Nothing to show for this session yet.</div>';
      return;
    }
    for (const m of data.messages) {
      const el = document.createElement('div');
      el.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
      const head = document.createElement('div');
      head.className = 'msg-head';
      head.innerHTML = `<span>${m.role === 'user' ? 'you' : 'claude'}</span>` +
        (m.ts ? `<span>${esc(String(m.ts).replace('T', ' ').slice(0, 16))}</span>` : '');
      head.appendChild(copyBtn(m.text, 'copy message'));
      el.appendChild(head);
      const body = document.createElement('div');
      body.className = 'msg-body';
      renderMarkdown(m.text, body);
      el.appendChild(body);
      convo.appendChild(el);
    }
    convo.scrollTop = (!quiet || nearBottom) ? convo.scrollHeight : scrollWas;
  }).catch(() => { if (!quiet) convo.innerHTML = '<div class="empty">Couldn\'t load this conversation.</div>'; });
}

// ---------------------------------------------------------------- terminal

let currentTermTarget = null;

// ---- terminal font size ----
// ⌘+ zooms the whole dashboard, so the terminal gets its own control,
// remembered per browser.
function termFontSize() {
  const v = parseInt(localStorage.getItem('deckTermFont') || '14', 10);
  return Math.min(22, Math.max(10, isNaN(v) ? 14 : v));
}
function bumpTermFont(delta) {
  const v = Math.min(22, Math.max(10, termFontSize() + delta));
  localStorage.setItem('deckTermFont', String(v));
  if (term) {
    term.options.fontSize = v;
    sendTermResize();
    term.focus();
  }
}
$('#font-dec').addEventListener('click', () => bumpTermFont(-1));
$('#font-inc').addEventListener('click', () => bumpTermFont(1));

// ---- terminal scrollbar ----
// The one scroll control, working like the copy-paste view's scrollbar:
// drag the thumb (or click the track) to move through the session's history.
// Position comes from tmux once a second; pos = lines above live, 0 = live.
// The "back to live" pill appears only while scrolled up. The bar hides when
// there is nothing to scroll: no history yet, or the session is showing a
// full-screen view (a menu or picker owns the whole screen).
let termScrollState = { history: 0, pos: 0, rows: 0, alt: 0 };
// Rough position estimate for fullscreen (paging) sessions: claude doesn't
// expose its scroll position, so we move the thumb by the pages we've sent.
// 0 = live/bottom, 1 = as far up as we've estimated.
let altPageEstimate = 0;

function renderTermBar() {
  const bar = $('#term-bar');
  const thumb = $('#term-bar-thumb');
  const { history, pos, rows, alt } = termScrollState;
  if (!currentTermTarget) {
    bar.classList.add('hidden');
    $('#term-live').classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  // one click back to the live end whenever we're up in history
  const scrolledUp = alt ? altPageEstimate > 0.01 : pos > 0;
  $('#term-live').classList.toggle('hidden', !scrolledUp);
  const trackH = bar.clientHeight;
  if (alt) {
    // Fullscreen claude UI (profiles first used after May 2026, or /tui
    // fullscreen): the scroll position lives inside claude, so the bar pages
    // rather than tracks — the thumb follows an estimate of where you are.
    // Dragging to the very bottom of the track jumps back to live.
    bar.title = 'Drag or click up / down to page through the conversation';
    const thumbH = Math.max(26, Math.round(trackH / 3));
    thumb.style.height = thumbH + 'px';
    thumb.style.top = Math.round((1 - altPageEstimate) * (trackH - thumbH)) + 'px';
    return;
  }
  const scrollable = history > 0;
  bar.title = scrollable ? 'Drag to scroll through the session'
    : 'Nothing to scroll yet — the whole session is on screen';
  const thumbH = scrollable ? Math.max(26, trackH * rows / (history + rows)) : trackH;
  const f = scrollable ? (history - pos) / history : 0; // 0 = top (or full), 1 = live
  thumb.style.height = thumbH + 'px';
  thumb.style.top = (f * (trackH - thumbH)) + 'px';
}

$('#term-live').addEventListener('click', () => {
  if (!termWs || termWs.readyState !== 1) return;
  if (termScrollState.alt) {
    termWs.send(JSON.stringify({ type: 'page', dir: 'bottom' }));
    altPageEstimate = 0;
  } else {
    termWs.send(JSON.stringify({ type: 'scrollTo', pos: 0 }));
    termScrollState.pos = 0; // optimistic; the 1s report corrects drift
  }
  renderTermBar();
  if (term) term.focus();
});

(() => {
  const bar = $('#term-bar');
  const thumb = $('#term-bar-thumb');
  let lastSent = 0;
  let altY = 0, altAccum = 0; // paging accumulator for full-screen sessions
  const sendMsg = (obj) => {
    if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify(obj));
    if (obj.type === 'page') {
      if (obj.dir === 'up') altPageEstimate = Math.min(1, altPageEstimate + 0.08);
      else if (obj.dir === 'down') altPageEstimate = Math.max(0, altPageEstimate - 0.08);
      else if (obj.dir === 'bottom') altPageEstimate = 0;
      renderTermBar();
    }
  };
  const posFromY = (clientY) => {
    const rect = bar.getBoundingClientRect();
    const thumbH = thumb.offsetHeight;
    const f = Math.max(0, Math.min((clientY - rect.top - thumbH / 2) / (rect.height - thumbH || 1), 1));
    return Math.round(termScrollState.history * (1 - f));
  };
  const sendPos = (pos, force) => {
    const now = Date.now();
    if (!force && now - lastSent < 90) return;
    lastSent = now;
    termScrollState.pos = pos; // optimistic; the 1s report corrects drift
    renderTermBar();
    sendMsg({ type: 'scrollTo', pos });
  };
  const move = (e) => {
    if (termScrollState.alt) {
      // ~35px of drag = one page in claude's full-screen view
      altAccum += e.clientY - altY;
      altY = e.clientY;
      while (altAccum <= -35) { sendMsg({ type: 'page', dir: 'up' }); altAccum += 35; }
      while (altAccum >= 35) { sendMsg({ type: 'page', dir: 'down' }); altAccum -= 35; }
      return;
    }
    sendPos(posFromY(e.clientY));
  };
  const up = (e) => {
    bar.classList.remove('dragging');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    if (termScrollState.alt) {
      // released at the very bottom of the track = jump back to live
      const r = bar.getBoundingClientRect();
      if (e.clientY >= r.bottom - 14) sendMsg({ type: 'page', dir: 'bottom' });
    } else {
      sendPos(posFromY(e.clientY), true);
    }
  };
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    deckLog('bar drag: target=' + currentTermTarget +
      ' ws=' + (termWs ? termWs.readyState : 'none') +
      ' hist=' + termScrollState.history + ' pos=' + termScrollState.pos +
      ' alt=' + termScrollState.alt);
    bar.classList.add('dragging');
    if (termScrollState.alt) {
      altY = e.clientY;
      altAccum = 0;
      const r = bar.getBoundingClientRect();
      sendMsg({ type: 'page', dir: e.clientY < r.top + r.height / 2 ? 'up' : 'down' });
    } else {
      sendPos(posFromY(e.clientY), true);
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
})();

let termWsRetry = null;

// Report client-side terminal events into the server log, so "it doesn't work
// on my machine" turns into a line saying exactly which layer failed.
function deckLog(msg) {
  try {
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg }),
    }).catch(() => {});
  } catch {}
}

// The terminal socket dies silently on server restarts and laptop sleep, and a
// frozen idle screen looks exactly like a live one. While the session view is
// open, keep reconnecting until it comes back.
function openTermWs(s, note, isReconnect) {
  if (!term) return;
  if (isReconnect) term.reset(); // tmux repaints the whole screen on attach
  termWs = new WebSocket(`ws://${location.host}/term?target=${encodeURIComponent(s.tmuxTarget)}`);
  termWs.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'data') term.write(m.data);
    if (m.type === 'scroll') { termScrollState = m; renderTermBar(); }
    if (m.type === 'error') { note.classList.remove('hidden'); note.textContent = m.message; }
  };
  termWs.onopen = () => {
    if (isReconnect) { note.classList.add('hidden'); deckLog('term reconnected: ' + s.tmuxTarget); }
    sendTermResize(true); // fresh server-side pty starts at a default size — always tell it ours
  };
  termWs.onclose = () => {
    if (!term || currentTermTarget !== s.tmuxTarget) return; // deliberately closed
    deckLog('term connection lost: ' + s.tmuxTarget + ' — reconnecting');
    note.textContent = 'Terminal connection lost — reconnecting…';
    note.classList.remove('hidden');
    termWsRetry = setTimeout(() => openTermWs(s, note, true), 1500);
  };
}

function disconnectTerm() {
  currentTermTarget = null;
  termScrollState = { history: 0, pos: 0, rows: 0, alt: 0 };
  altPageEstimate = 0;
  $('#term-bar').classList.add('hidden');
  $('#term-live').classList.add('hidden');
  $('#term-focus-hint').classList.add('hidden');
  clearTimeout(termWsRetry);
  if (termWs) { termWs.onclose = null; try { termWs.close(); } catch {} termWs = null; }
  // an addon's dispose bug must never wedge the view half-closed
  if (term) { try { term.dispose(); } catch {} term = null; }
  $('#term').innerHTML = '';
}

function connectTerm(s) {
  disconnectTerm();
  const pane = $('#term-pane');
  const note = $('#detail-note');
  if (!s.embeddable || !s.tmuxTarget) {
    // no terminal: the pastable conversation IS the view
    pane.classList.add('hidden');
    note.classList.remove('hidden');
    note.innerHTML = `This session is running in its own terminal tab, so there is no live terminal here. The conversation below is the useful part anyway: every message copies out as clean text, with none of the wrapping and stray symbols a terminal adds. Start a session with <code>cc</code> when you also want a typeable terminal in this view.`;
    return;
  }
  note.classList.add('hidden');
  pane.classList.remove('hidden');
  currentTermTarget = s.tmuxTarget;
  lastTermSize = { cols: 0, rows: 0 }; // new terminal: first fit always reports its size
  // the bar is on screen from the first paint; tmux's report refines it within a second
  termScrollState = { history: 0, pos: 0, rows: 0, alt: 0 };
  renderTermBar();
  term = new Terminal({
    fontSize: termFontSize(),
    // lineHeight stays at 1: anything higher leaves gaps in the vertical
    // box-drawing lines of claude's UI (xterm's glyphs don't stretch into
    // line padding) — verified 2026-08-19, boxes render dashed at 1.2
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: TERM_THEMES[themeMode()],
    cursorBlink: true,
    scrollback: 5000,
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  // plain URLs in the output become clickable, like in a regular terminal
  term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
  // real hyperlink escapes (OSC 8), should anything emit them, open the same way
  term.options.linkHandler = { activate: (e, uri) => window.open(uri, '_blank', 'noopener') };
  term.open($('#term'));
  // GPU renderer for smooth repaints on busy sessions; anything goes wrong
  // (no WebGL, context lost) and xterm silently falls back to the DOM renderer
  if (window.WebglAddon) {
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch { /* DOM renderer it is */ }
  }
  fitAddon.fit();
  // keystrokes should land the moment the view opens, and the state should be
  // visible: an unfocused terminal shows the "click to type" hint instead of
  // silently eating input
  term.focus();
  const hint = $('#term-focus-hint');
  hint.classList.add('hidden');
  term.textarea.addEventListener('focus', () => hint.classList.add('hidden'));
  term.textarea.addEventListener('blur', () => {
    if (currentTermTarget && document.hasFocus()) hint.classList.remove('hidden');
  });

  openTermWs(s, note, false);
  // refit once layout has fully settled (scrollbars, fonts) — a stale first
  // measurement here is what clips the rightmost columns
  setTimeout(sendTermResize, 200);
  term.onData(d => { if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'input', data: d })); });
  const ro = new ResizeObserver(sendTermResize);
  ro.observe($('#term'));
}

// ---------------------------------------------------------------- tabs + config

document.querySelectorAll('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
  });
});

function applySidebar() {
  const closed = localStorage.getItem('deckSidebar') === 'closed';
  document.body.classList.toggle('no-sidebar', closed);
  const b = $('#sideToggle');
  b.textContent = closed ? 'Show panel' : 'Hide panel';
  b.title = closed
    ? 'Bring back the to-dos / artifacts / PRs panel'
    : 'Hide the side panel so the cards get the full width';
}
$('#sideToggle').addEventListener('click', () => {
  localStorage.setItem('deckSidebar', localStorage.getItem('deckSidebar') === 'closed' ? 'open' : 'closed');
  applySidebar();
});
applySidebar();

$('#sortSel').value = sortMode;
$('#sortSel').addEventListener('change', (e) => {
  sortMode = e.target.value;
  localStorage.setItem('deckSort', sortMode);
  renderGrid();
});

// ---- new session dialog ----
const nsOverlay = $('#ns-overlay');
let browseSeq = 0;     // ignore out-of-order browse responses while typing
let recentPool = [];   // recent project dirs, captured when the dialog opens

function nsDirRow(container, label, target, cls) {
  const d = document.createElement('div');
  d.className = 'ns-dir ' + (cls || '');
  d.textContent = label;
  d.title = target;
  d.addEventListener('click', () => {
    $('#ns-cwd').value = target;
    browseTo(target);
  });
  container.appendChild(d);
}

// Recent projects, minus anything already on screen in the folder list below:
// the folder being browsed and its direct children would show up twice.
function renderRecent(currentPath) {
  const rec = $('#ns-recent');
  rec.innerHTML = '';
  const norm = p => String(p).replace(/\/+$/, '');
  const cur = norm(currentPath || '');
  const shown = recentPool.map(norm).filter(n =>
    n && n !== cur && n.slice(0, n.lastIndexOf('/')) !== cur).slice(0, 8);
  $('#ns-recent-head').classList.toggle('hidden', !shown.length);
  rec.classList.toggle('hidden', !shown.length);
  $('#ns-divider').classList.toggle('hidden', !shown.length);
  for (const d of shown) nsDirRow(rec, '🕘 ' + d, d, 'recent');
}

// A real folder browser: the list under the path input always shows the
// subfolders of the nearest existing folder on the typed path. Click to
// descend, ".." to go up, or pick a recent project. Full paths throughout.
function browseTo(p) {
  const seq = ++browseSeq;
  fetch('/api/browse?path=' + encodeURIComponent(p || '')).then(r => r.json()).then(b => {
    if (seq !== browseSeq) return;
    const here = $('#ns-browse-here');
    here.textContent = 'folders in ' + shortPath(b.path);
    here.title = b.path;
    const list = $('#ns-browse-list');
    list.innerHTML = '';
    if (b.parent) nsDirRow(list, '↑ up one level', b.parent, 'up');
    for (const name of b.dirs || []) {
      nsDirRow(list, '📁 ' + name, b.path + (b.path.endsWith('/') ? '' : '/') + name);
    }
    if (b.error) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = b.error;
      list.appendChild(e);
    } else if (!(b.dirs || []).length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'no subfolders';
      list.appendChild(e);
    }
    renderRecent(b.path);
  }).catch(() => {});
}

let browseTimer = null;
$('#ns-cwd').addEventListener('input', () => {
  clearTimeout(browseTimer);
  browseTimer = setTimeout(() => browseTo($('#ns-cwd').value.trim()), 250);
});

// ---- dialog sizing ----
// The dialog resizes from its bottom-right corner (CSS resize); the divider
// between the two lists portions their space. Both are remembered.
function restoreNsLayout() {
  const dlg = $('#ns-dialog');
  try {
    const size = JSON.parse(localStorage.getItem('deckNsSize') || 'null');
    if (size && size.w && size.h) { dlg.style.width = size.w + 'px'; dlg.style.height = size.h + 'px'; }
  } catch {}
  const rh = parseInt(localStorage.getItem('deckNsRecentH') || '', 10);
  if (rh) $('#ns-recent').style.height = rh + 'px';
}

function closeNsDialog() {
  const dlg = $('#ns-dialog');
  localStorage.setItem('deckNsSize', JSON.stringify({ w: dlg.offsetWidth, h: dlg.offsetHeight }));
  const rec = $('#ns-recent');
  if (rec.offsetHeight) localStorage.setItem('deckNsRecentH', String(rec.offsetHeight));
  nsOverlay.classList.add('hidden');
}

(() => {
  const div = $('#ns-divider');
  const rec = $('#ns-recent');
  let startY = 0, startH = 0;
  const move = (e) => {
    const room = $('#ns-browse').offsetHeight - 130; // keep the folder list usable
    rec.style.height = Math.max(24, Math.min(startH + (e.clientY - startY), room)) + 'px';
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  div.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = rec.offsetHeight;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
})();

$('#newSession').addEventListener('click', () => {
  const start = $('#ns-cwd').value.trim() ||
    localStorage.getItem('deckLastDir') || state.home || '';
  $('#ns-cwd').value = start;
  const dirs = new Set(state.recentDirs || []);
  for (const s of state.sessions) if (s.cwd) dirs.add(s.cwd);
  recentPool = [...dirs];
  browseTo(start); // renders the folder list and the filtered recent list
  const aw = $('#ns-acct-wrap');
  if ((state.profiles || []).length > 1) {
    aw.classList.remove('hidden');
    const sel = $('#ns-acct');
    sel.innerHTML = '';
    for (const p of state.profiles) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label + ' — ' + (p.email ||
        (p.hasToken ? 'own token login' : 'no login yet — opens at the sign-in screen'));
      sel.appendChild(o);
    }
    const lastProf = localStorage.getItem('deckLastProfile');
    if (lastProf && state.profiles.some(p => p.id === lastProf)) sel.value = lastProf;
  } else {
    aw.classList.add('hidden');
  }
  $('#ns-err').textContent = '';
  restoreNsLayout();
  nsOverlay.classList.remove('hidden');
  $('#ns-cwd').focus();
});

$('#ns-cancel').addEventListener('click', closeNsDialog);
// close on a true backdrop click only: a resize or divider drag that ends
// outside the dialog also registers as an overlay "click" — ignore those
let nsPressOnOverlay = false;
nsOverlay.addEventListener('mousedown', (e) => { nsPressOnOverlay = e.target === nsOverlay; });
nsOverlay.addEventListener('click', (e) => {
  if (e.target === nsOverlay && nsPressOnOverlay) closeNsDialog();
});

function startNewSession() {
  let name = $('#ns-name').value.trim();
  if (!name) {
    const base = ($('#ns-cwd').value.trim().split('/').filter(Boolean).pop() || 'session');
    name = base + '-' + new Date().toTimeString().slice(0, 5).replace(':', '');
  }
  const cwd = $('#ns-cwd').value.trim();
  const profile = $('#ns-acct-wrap').classList.contains('hidden') ? 'main' : $('#ns-acct').value;
  fetch('/api/new-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, cwd, profile }),
  }).then(r => r.json()).then(j => {
    if (j.error) { $('#ns-err').textContent = j.error; return; }
    localStorage.setItem('deckLastDir', cwd);
    localStorage.setItem('deckLastProfile', profile);
    closeNsDialog();
    $('#ns-name').value = '';
    // Open the terminal immediately — don't wait for the session to register.
    // If claude comes up at a login screen or any other prompt, you see it
    // and can type into it right here.
    pendingSession = {
      sessionId: 'tmux:' + j.target,
      name: j.name, rawName: j.name, cwd,
      status: 'starting', alive: true,
      embeddable: true, tmuxTarget: j.target,
    };
    openDetail(pendingSession.sessionId);
  }).catch(() => { $('#ns-err').textContent = 'could not reach the server'; });
}
$('#ns-go').addEventListener('click', startNewSession);
$('#ns-dialog').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'ns-cwd') { $('#ns-name').focus(); return; } // confirm folder, move on
  startNewSession();
});

$('#autoNudge').addEventListener('change', (e) => {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoNudge: e.target.checked }),
  });
});

// ---------------------------------------------------------------- live connection

let deepLinked = false;
let liveSnapshots = false;

let pageAppVersion = null;

function applySnapshot(m) {
  // the dashboard code on disk moved on (server sends the UI files' version):
  // pick up the new page instead of silently running the old one
  if (m.appVersion) {
    if (pageAppVersion === null) pageAppVersion = m.appVersion;
    else if (pageAppVersion !== m.appVersion) { location.reload(); return; }
  }
  state = m;
  // once a snapshot carries the session we launched (as its synthetic "starting"
  // card or the real registered session), the local placeholder has done its job
  if (pendingSession && state.sessions.some(x =>
      x.sessionId === pendingSession.sessionId || x.tmuxTarget === pendingSession.tmuxTarget)) {
    pendingSession = null;
  }
  // the open detail view follows its tmux pane: when the "starting" card gives
  // way to the real registered session, swap ids without touching the terminal
  if (detailSessionId && String(detailSessionId).startsWith('tmux:') &&
      !state.sessions.some(x => x.sessionId === detailSessionId)) {
    const target = String(detailSessionId).slice(5);
    const real = state.sessions.find(x => x.tmuxTarget === target);
    if (real) {
      detailSessionId = real.sessionId;
      applyConvoVisibility(real);
      if (convoVisible) loadConversation(real.sessionId);
    }
  }
  renderGrid();
  renderSidebar();
  if (detailSessionId) renderDetail(false);
  // ?session=<id> deep-links straight into a session's detail view
  if (!deepLinked) {
    deepLinked = true;
    const want = new URLSearchParams(location.search).get('session');
    if (want && state.sessions.some(s => s.sessionId === want)) openDetail(want);
  }
}

let currentWs = null;
let lastSnapshotAt = 0;

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  currentWs = ws;
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'snapshot') { liveSnapshots = true; lastSnapshotAt = Date.now(); applySnapshot(m); }
  };
  ws.onopen = () => $('#disconnected').classList.add('hidden');
  ws.onclose = () => {
    $('#disconnected').classList.remove('hidden');
    setTimeout(connect, 2000);
  };
}
connect();

// The server broadcasts every few seconds, so a long silence means the
// connection died without saying so (laptop sleep does this). Closing the
// dead socket triggers the normal reconnect path above.
function nudgeConnection(staleMs) {
  if (lastSnapshotAt && Date.now() - lastSnapshotAt > staleMs && currentWs) {
    try { currentWs.close(); } catch {}
  }
}
setInterval(() => nudgeConnection(15000), 10000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) nudgeConnection(6000);
});

// paint immediately from a plain fetch; the WebSocket takes over from there
fetch('/api/state').then(r => r.json())
  .then(m => { if (!liveSnapshots && m && m.type === 'snapshot') applySnapshot(m); })
  .catch(() => {});
