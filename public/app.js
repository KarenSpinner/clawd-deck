/* Clawd Deck client. Live over WebSocket, no framework. */

let state = { sessions: [], prs: { mine: [], needsMe: [] }, config: {} };
let detailSessionId = null;
let term = null, termWs = null, fitAddon = null;

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

// ---------------------------------------------------------------- grid

let sortMode = localStorage.getItem('deckSort') || 'attention';

function sortSessions(list) {
  const rank = st => (st === 'waiting' ? 0 : st === 'ready' ? 1 : st === 'working' ? 2 : st === 'idle' ? 3 : 4);
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
    row1.innerHTML = `<span class="dot ${esc(s.status)}"></span>
      <span class="name" title="${esc(s.rawName || '')}">${esc(s.name || s.sessionId.slice(0, 8))}</span>`;
    const ren = document.createElement('button');
    ren.className = 'rename-btn';
    ren.textContent = '✎';
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
    row1.appendChild(ren);
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
    } else if (s.compacting) {
      const b = document.createElement('span');
      b.className = 'badge compacting';
      b.textContent = 'COMPACTING';
      row1.appendChild(b);
    } else if (s.status === 'ended') {
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
    card.appendChild(row1);

    if (s.subtitle) {
      const sub = document.createElement('div');
      sub.className = 'subtitle';
      sub.textContent = s.subtitle;
      card.appendChild(sub);
    }

    const chips = document.createElement('div');
    chips.className = 'chips';
    if (s.cwd) chips.innerHTML += `<span class="chip">${esc(shortPath(s.cwd))}</span>`;
    if (s.gitBranch) chips.innerHTML += `<span class="chip branch">⎇ ${esc(s.gitBranch)}</span>`;
    if ((state.profiles || []).length > 1 && s.accountLabel) {
      const hue = [...String(s.accountLabel)].reduce((a, c) => a + c.charCodeAt(0) * 37, 0) % 360;
      const tip = s.profileId === 'main'
        ? 'Shared main login, currently ' + (s.account || 'unknown') + '. Running /login in any main session switches all of them.'
        : (s.account || 'own login, separate from the main one');
      chips.innerHTML += `<span class="chip account" title="${esc(tip)}"
        style="color:hsl(${hue},55%,30%);border-color:hsl(${hue},40%,72%);background:hsl(${hue},50%,96%)">⚉ ${esc(s.accountLabel)}</span>`;
    }
    card.appendChild(chips);

    if (typeof s.contextPct === 'number') {
      const g = document.createElement('div');
      g.className = 'gauge' + (s.contextPct > 85 ? ' crit' : s.contextPct > 60 ? ' hot' : '');
      g.innerHTML = `<div style="width:${Math.max(1, s.contextPct)}%"></div>`;
      card.appendChild(g);
      const gl = document.createElement('div');
      gl.className = 'gauge-label';
      gl.textContent = `context ${s.contextPct}%` +
        (s.contextTokens ? ` · ${Math.round(s.contextTokens / 1000)}k` : '') +
        (s.lastActivityAt ? ` · active ${ago(s.lastActivityAt)}` : '');
      card.appendChild(gl);
    }

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

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (s.artifactCount) {
      const a = document.createElement('span');
      a.className = 'artifact-count';
      a.textContent = `📄 ${s.artifactCount}`;
      actions.appendChild(a);
    }
    if (s.nudge) {
      const n = document.createElement('span');
      n.className = 'nudge-note';
      n.textContent = s.nudge.state === 'running' ? 'memory: updating…'
        : s.nudge.state === 'done' ? 'memory ✓' : 'memory ✗';
      n.title = s.nudge.summary || '';
      actions.appendChild(n);
    }
    actions.innerHTML += '<span class="spacer"></span>';
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
    card.appendChild(actions);

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
const sidebarKeys = { todos: null, artifacts: null, prs: null };

function rebuildPanel(panel, keyName, key, build) {
  if (sidebarKeys[keyName] === key) return;
  sidebarKeys[keyName] = key;
  const scrollWas = panel.scrollTop;
  panel.innerHTML = '';
  build(panel);
  panel.scrollTop = scrollWas;
}

function renderSidebar() {
  rebuildPanel($('#tab-todos'), 'todos',
    JSON.stringify(state.sessions.map(s => [s.name, s.todos])), renderTodosPanel);
  rebuildPanel($('#tab-artifacts'), 'artifacts',
    JSON.stringify(state.sessions.map(s => [s.sessionId, s.name, s.artifactCount])), renderArtifactsPanel);
  rebuildPanel($('#tab-prs'), 'prs',
    JSON.stringify([state.prs.mine, state.prs.needsMe, state.prs.error]), renderPrsPanel);
}

function renderTodosPanel(tp) {
  let anyTodos = false;
  for (const s of state.sessions) {
    if (!s.todos || !s.todos.length) continue;
    anyTodos = true;
    const g = document.createElement('div');
    g.className = 'side-group';
    g.innerHTML = `<h4>${esc(s.name || s.sessionId.slice(0, 8))}</h4>`;
    for (const t of s.todos) {
      const d = document.createElement('div');
      d.className = 'side-item t ' + esc(t.status);
      d.textContent = (t.status === 'completed' ? '✓ ' : t.status === 'in_progress' ? '▸ ' : '○ ') + t.content;
      if (t.status === 'completed') d.style.opacity = '.5';
      g.appendChild(d);
    }
    tp.appendChild(g);
  }
  if (!anyTodos) tp.innerHTML = '<div class="empty">No to-dos yet. When a session writes itself a task list, it shows up here.</div>';
}

function renderArtifactsPanel(ap) {
  let anyArt = false;
  for (const s of state.sessions) {
    if (!s.artifactCount) continue;
    anyArt = true;
    const g = document.createElement('div');
    g.className = 'side-group';
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

function renderDetail(fresh) {
  const s = state.sessions.find(x => x.sessionId === detailSessionId);
  if (!s) return;
  $('#detail-title').textContent = s.name || s.sessionId.slice(0, 8);
  $('#detail-meta').textContent =
    `${shortPath(s.cwd || '')}${s.gitBranch ? ' ⎇ ' + s.gitBranch : ''}` +
    `${typeof s.contextPct === 'number' ? ' · context ' + s.contextPct + '%' : ''} · ${s.status}`;
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
    btn.textContent = convoVisible ? 'hide copy-paste view' : 'copy-paste view';
    btn.title = 'The conversation as clean text, with a copy button on every message and code block';
    $('#convo-pane').classList.toggle('hidden', !convoVisible);
  } else {
    btn.classList.add('hidden');
    $('#convo-pane').classList.remove('hidden');
  }
  // the terminal reclaims or cedes width; refit it after layout settles
  setTimeout(() => {
    if (!term || !fitAddon) return;
    try {
      fitAddon.fit();
      if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } catch {}
  }, 60);
}

$('#convo-toggle').addEventListener('click', () => {
  convoVisible = !convoVisible;
  localStorage.setItem('deckConvo', convoVisible ? 'show' : 'hide');
  const s = state.sessions.find(x => x.sessionId === detailSessionId);
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

function disconnectTerm() {
  if (termWs) { try { termWs.close(); } catch {} termWs = null; }
  if (term) { term.dispose(); term = null; }
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
  term = new Terminal({
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: { background: '#000000' },
    cursorBlink: true,
    scrollback: 5000,
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('#term'));
  fitAddon.fit();

  termWs = new WebSocket(`ws://${location.host}/term?target=${encodeURIComponent(s.tmuxTarget)}`);
  termWs.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'data') term.write(m.data);
    if (m.type === 'error') { note.classList.remove('hidden'); note.textContent = m.message; }
  };
  termWs.onopen = () => {
    termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  term.onData(d => { if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'input', data: d })); });
  const ro = new ResizeObserver(() => {
    if (!term) return;
    fitAddon.fit();
    if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  });
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
  document.body.classList.toggle('no-sidebar', localStorage.getItem('deckSidebar') === 'closed');
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
let pendingOpen = null;
const nsOverlay = $('#ns-overlay');

$('#newSession').addEventListener('click', () => {
  const dl = $('#ns-dirs');
  dl.innerHTML = '';
  const dirs = new Set(state.recentDirs || []);
  for (const s of state.sessions) if (s.cwd) dirs.add(s.cwd);
  for (const d of dirs) {
    const o = document.createElement('option');
    o.value = shortPath(d);
    dl.appendChild(o);
  }
  const aw = $('#ns-acct-wrap');
  if ((state.profiles || []).length > 1) {
    aw.classList.remove('hidden');
    const sel = $('#ns-acct');
    sel.innerHTML = '';
    for (const p of state.profiles) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label + ' — ' + (p.email || (p.hasToken ? 'own token login' : 'not set up yet'));
      sel.appendChild(o);
    }
  } else {
    aw.classList.add('hidden');
  }
  $('#ns-err').textContent = '';
  nsOverlay.classList.remove('hidden');
  $('#ns-cwd').focus();
});

$('#ns-cancel').addEventListener('click', () => nsOverlay.classList.add('hidden'));
nsOverlay.addEventListener('click', (e) => { if (e.target === nsOverlay) nsOverlay.classList.add('hidden'); });

function startNewSession() {
  let name = $('#ns-name').value.trim();
  if (!name) {
    const base = ($('#ns-cwd').value.trim().split('/').filter(Boolean).pop() || 'session');
    name = base + '-' + new Date().toTimeString().slice(0, 5).replace(':', '');
  }
  fetch('/api/new-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      cwd: $('#ns-cwd').value.trim(),
      profile: $('#ns-acct-wrap').classList.contains('hidden') ? 'main' : $('#ns-acct').value,
    }),
  }).then(r => r.json()).then(j => {
    if (j.error) { $('#ns-err').textContent = j.error; return; }
    pendingOpen = j.name;
    nsOverlay.classList.add('hidden');
    $('#ns-name').value = '';
  }).catch(() => { $('#ns-err').textContent = 'could not reach the server'; });
}
$('#ns-go').addEventListener('click', startNewSession);
$('#ns-dialog').addEventListener('keydown', (e) => { if (e.key === 'Enter') startNewSession(); });

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

function applySnapshot(m) {
  state = m;
  renderGrid();
  renderSidebar();
  if (detailSessionId) renderDetail(false);
  // a session just started from the dashboard: open it as soon as it appears
  if (pendingOpen) {
    const s = state.sessions.find(x => x.rawName === pendingOpen);
    if (s) { pendingOpen = null; openDetail(s.sessionId); }
  }
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
