// Personal Agent dashboard. Plain JavaScript modules, no build step needed.
const TZ = 'Australia/Melbourne';
const $ = (sel, el = document) => el.querySelector(sel);

const SECTIONS = [
  { id: 'home', label: 'Home', ico: '◎', tab: true },
  { id: 'chat', label: 'AI Chat', ico: '✦', tab: true },
  { id: 'tasks', label: 'Tasks', ico: '☑', tab: true },
  { id: 'finance', label: 'Finance', ico: '$', phase: 2 },
  { id: 'goals', label: 'Goals', ico: '★', phase: 2 },
  { id: 'social', label: 'Social Studio', ico: '▶', phase: 3 },
  { id: 'automations', label: 'Automations', ico: '⟳', phase: 4 },
  { id: 'memory', label: 'Memory', ico: '◈', tab: true },
  { id: 'settings', label: 'Settings', ico: '⚙', tab: true },
];

// ---------- helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), 'X-Requested-With': 'personal-agent' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) { boot(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}
function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function auDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', ...opts }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}
function auDateTime(ts) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
}
function relDay(iso) {
  const t = todayIso();
  if (iso === t) return 'Today';
  const diff = Math.round((new Date(iso) - new Date(t)) / 86400000);
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return auDate(iso);
}
// Tiny, safe markdown: escape everything first, then add bold, inline code, bullet lists and paragraphs.
function md(text) {
  const lines = esc(text).split('\n');
  let html = '', inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${m[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (line.trim().startsWith('#')) html += `<p><b>${line.replace(/^#+\s*/, '')}</b></p>`;
    else if (line.trim()) html += `<p>${line}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}

// ---------- auth ----------
async function boot() {
  const s = await api('/api/auth/status');
  if (!s.loggedIn) return showAuth(s.needsSetup);
  $('#auth').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  state.me = await api('/api/me');
  $('#who').textContent = state.me.email;
  route();
}
function showAuth(needsSetup) {
  $('#shell').classList.add('hidden');
  const el = $('#auth');
  el.classList.remove('hidden');
  el.innerHTML = `
    <form class="card" id="authForm">
      <div class="brand" style="padding:0"><span class="logo">A</span><span>Personal Agent</span></div>
      <h1>${needsSetup ? 'Create your account' : 'Welcome back'}</h1>
      ${needsSetup ? '<p class="muted small" style="margin:0">First run. Enter the SETUP_CODE from your .env file. Only one account can be created.</p>' : ''}
      ${needsSetup ? '<label>Your name<input name="displayName" autocomplete="name" required></label>' : ''}
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password ${needsSetup ? '<span class="small">(12+ characters)</span>' : ''}<input name="password" type="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" minlength="${needsSetup ? 12 : 1}" required></label>
      ${needsSetup ? '<label>Setup code<input name="setupCode" required></label>' : ''}
      <div class="err" id="authErr"></div>
      <button class="btn" type="submit">${needsSetup ? 'Create account' : 'Log in'}</button>
    </form>`;
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      await api(needsSetup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body });
      boot();
    } catch (err) { $('#authErr').textContent = err.message; }
  };
}
$('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); boot(); };

// ---------- shell & routing ----------
const state = { me: null, convId: null, taskTab: 'today' };

function renderNav(active) {
  $('#nav').innerHTML = SECTIONS.map((s) => `
    <a class="nav-item ${s.id === active ? 'active' : ''}" href="#/${s.id}">
      <span class="ico">${s.ico}</span>${esc(s.label)}${s.phase ? `<span class="tag">Phase ${s.phase}</span>` : ''}
    </a>`).join('');
  $('#tabbar').innerHTML = SECTIONS.filter((s) => s.tab).map((s) => `
    <a class="${s.id === active ? 'active' : ''}" href="#/${s.id}"><span class="ico">${s.ico}</span>${esc(s.label.replace('AI ', ''))}</a>`).join('');
}
$('#menu').onclick = () => $('#shell').classList.toggle('menu-open');
$('#scrim').onclick = () => $('#shell').classList.remove('menu-open');
window.addEventListener('hashchange', route);

function tickClock() {
  $('#clock').textContent = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date());
}
setInterval(tickClock, 30_000);

async function route() {
  if (!state.me) return;
  const [, id = 'home', arg] = location.hash.split('/');
  const section = SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
  renderNav(section.id);
  $('#title').textContent = section.label;
  $('#shell').classList.remove('menu-open');
  tickClock();
  const view = $('#view');
  view.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const fn = VIEWS[section.id] ?? (() => comingSoon(section));
    await fn(view, arg);
  } catch (err) {
    view.innerHTML = `<div class="card"><b>Couldn't load this page.</b><p class="muted">${esc(err.message)}</p></div>`;
  }
}

// ---------- task rendering (shared) ----------
function taskItem(t) {
  const overdue = t.status === 'todo' && t.due_date && t.due_date < todayIso();
  return `<li class="task ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
    <button class="check" data-act="toggle" aria-label="Mark done">${t.status === 'done' ? '✓' : ''}</button>
    <div class="t-body">
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-meta">
        ${t.priority !== 'low' ? `<span class="pill ${t.priority}">${t.priority}</span>` : ''}
        ${overdue ? '<span class="pill overdue">overdue</span>' : ''}
        ${t.due_date ? `<span>${relDay(t.due_date)}${t.due_time ? ` · ${t.due_time}` : ''}</span>` : ''}
        ${t.estimate_min ? `<span>· ${t.estimate_min} min</span>` : ''}
        ${t.recurrence ? `<span>· repeats ${t.recurrence}</span>` : ''}
        ${t.is_habit ? '<span>· habit</span>' : ''}
        ${t.created_by === 'agent' ? '<span>· added by AI</span>' : ''}
      </div>
      ${t.notes ? `<div class="small muted">${esc(t.notes)}</div>` : ''}
    </div>
    <div class="t-actions">
      ${t.status === 'todo' ? '<button data-act="tomorrow" title="Move to tomorrow">→</button>' : ''}
      <button data-act="delete" title="Delete">✕</button>
    </div>
  </li>`;
}
function taskList(tasks, emptyText = 'Nothing here.') {
  return tasks.length ? `<ul class="tasks">${tasks.map(taskItem).join('')}</ul>` : `<div class="empty">${esc(emptyText)}</div>`;
}
function bindTaskActions(root, refresh) {
  root.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const li = btn.closest('.task');
    const id = li.dataset.id;
    try {
      if (btn.dataset.act === 'toggle') {
        if (li.classList.contains('done')) await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: 'todo' } });
        else {
          const r = await api(`/api/tasks/${id}/complete`, { method: 'POST' });
          toast(r.next ? `Done. Next one scheduled for ${auDate(r.next.due_date)}.` : 'Nice work, task done.');
        }
      } else if (btn.dataset.act === 'tomorrow') {
        const d = new Date(`${todayIso()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
        await api(`/api/tasks/${id}`, { method: 'PATCH', body: { due_date: d.toISOString().slice(0, 10) } });
        toast('Moved to tomorrow.');
      } else if (btn.dataset.act === 'delete') {
        if (!confirm('Delete this task permanently?')) return;
        await api(`/api/tasks/${id}`, { method: 'DELETE' });
      }
      refresh();
    } catch (err) { toast(err.message); }
  };
}
function bars(days) {
  const max = Math.max(1, ...days.map((d) => d.completed));
  return `<div class="bars">${days.map((d) => `
    <div class="bar" title="${auDate(d.date)}: ${d.completed} done">
      <b>${d.completed || ''}</b><i style="height:${(d.completed / max) * 80 + 3}%"></i><span>${auDate(d.date, { weekday: 'narrow' })}</span>
    </div>`).join('')}</div>`;
}

// ---------- views ----------
const VIEWS = {
  async home(view) {
    const h = await api('/api/home');
    const o = h.overview;
    const hour = Number(new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()));
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const top = [...o.overdue, ...o.due_today].slice(0, 3);
    view.innerHTML = `
      <div class="grid">
        <div class="card hero">
          <p class="greet">${greet}, ${esc(state.me.display_name)}</p>
          <div class="muted">${auDate(o.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · Melbourne</div>
          <p style="margin:12px 0 0">You have <b>${o.due_today.length}</b> task${o.due_today.length === 1 ? '' : 's'} due today${o.overdue.length ? ` and <b style="color:var(--bad)">${o.overdue.length} overdue</b>` : ''}. ${o.completed_today.length ? `You've finished ${o.completed_today.length} so far.` : ''}</p>
          ${top.length ? `<p class="small muted" style="margin:6px 0 0">Focus first on: ${top.map((t) => esc(t.title)).join(' · ')}</p>` : ''}
          <div class="row" style="margin-top:14px">
            <a class="btn" href="#/chat" data-prompt="Plan my day today">Plan my day with AI</a>
            <a class="btn ghost" href="#/tasks">Open tasks</a>
          </div>
        </div>
        <div class="grid cols-3">
          <div class="card"><h2>Due today</h2><div class="stat">${o.due_today.length}</div><div class="stat-sub">${o.completed_today.length} completed today</div></div>
          <div class="card"><h2>Overdue</h2><div class="stat" style="color:${o.overdue.length ? 'var(--bad)' : 'inherit'}">${o.overdue.length}</div><div class="stat-sub">${o.upcoming_7_days.length} due in the next 7 days</div></div>
          <div class="card"><h2>This week</h2><div class="stat">${h.week.completion_rate ?? '–'}${h.week.completion_rate !== null ? '%' : ''}</div><div class="stat-sub">${h.week.completed_on_time} of ${h.week.planned} planned tasks done on time</div></div>
        </div>
        ${h.pending_approvals.length ? `<div class="card"><h2>Waiting for your approval</h2>${h.pending_approvals.map((p) => `<div class="row" style="padding:6px 0"><span>${esc(p.summary)}</span><span class="spacer"></span><a class="btn small ghost" href="#/chat/${p.conversation_id ?? ''}">Review</a></div>`).join('')}</div>` : ''}
        <div class="grid cols-2">
          <div class="card" id="homeToday"><h2>Today</h2>${taskList([...o.overdue, ...o.due_today], 'Nothing due today. Enjoy it, or add a task.')}</div>
          <div class="card"><h2>Completed this week</h2>${bars(h.week.completed_by_day)}
            <p class="small muted" style="margin:10px 0 0">Habits: ${h.week.habits.done} done of ${h.week.habits.planned} planned.</p></div>
        </div>
        <div class="card"><h2>Coming next</h2><p class="muted small" style="margin:0">Finance, savings goals and bills arrive in Phase 2, Social Studio in Phase 3, and the automatic 7 am / 1 pm / 8 pm briefings in Phase 4. Those sections are marked in the menu and are not active yet.</p></div>
      </div>`;
    bindTaskActions($('#homeToday'), () => route());
    view.querySelectorAll('[data-prompt]').forEach((a) => a.addEventListener('click', () => { state.pendingPrompt = a.dataset.prompt; state.convId = null; }));
  },

  async tasks(view) {
    const tabs = { today: 'Today', week: 'Next 7 days', overdue: 'Missed', all: 'All open', done: 'Completed', report: 'Weekly report' };
    view.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <form id="newTask" class="form-grid">
          <label class="wide">New task<input name="title" placeholder="e.g. Pay electricity bill" required maxlength="300"></label>
          <label>Due date<input name="due_date" type="date" value="${todayIso()}"></label>
          <label>Time<input name="due_time" type="time"></label>
          <label>Priority<select name="priority"><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option><option value="low">Low</option></select></label>
          <label>Repeats<select name="recurrence"><option value="">Never</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="fortnightly">Fortnightly</option><option value="monthly">Monthly</option></select></label>
          <label>Estimate (min)<input name="estimate_min" type="number" min="1" max="1440" placeholder="30"></label>
          <label style="flex-direction:row;display:flex;gap:8px;align-items:center"><input name="is_habit" type="checkbox"> Habit</label>
          <button class="btn" type="submit">Add task</button>
        </form>
      </div>
      <div class="tabs" id="taskTabs">${Object.entries(tabs).map(([k, v]) => `<button data-tab="${k}" class="${state.taskTab === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="card" id="taskPane"></div>`;
    $('#newTask').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const body = { title: f.title, priority: f.priority, due_date: f.due_date || null, due_time: f.due_time || null,
        recurrence: f.recurrence || null, estimate_min: f.estimate_min ? Number(f.estimate_min) : null, is_habit: f.is_habit === 'on' };
      try { await api('/api/tasks', { method: 'POST', body }); e.target.reset(); e.target.due_date.value = todayIso(); toast('Task added.'); loadPane(); }
      catch (err) { toast(err.message); }
    };
    $('#taskTabs').onclick = (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      state.taskTab = b.dataset.tab;
      view.querySelectorAll('#taskTabs button').forEach((x) => x.classList.toggle('on', x === b));
      loadPane();
    };
    const pane = $('#taskPane');
    bindTaskActions(pane, () => loadPane());
    async function loadPane() {
      const t = todayIso();
      const plus7 = (() => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })();
      const tab = state.taskTab;
      if (tab === 'report') {
        const r = await api('/api/tasks/weekly-report');
        pane.innerHTML = `<h2>Week of ${auDate(r.week_start)} – ${auDate(r.week_end)}</h2>
          <div class="grid cols-3" style="margin-bottom:14px">
            <div><div class="stat">${r.completed}</div><div class="stat-sub">tasks completed</div></div>
            <div><div class="stat">${r.completion_rate ?? '–'}${r.completion_rate !== null ? '%' : ''}</div><div class="stat-sub">planned tasks done on time (${r.completed_on_time}/${r.planned})</div></div>
            <div><div class="stat">${r.habits.done}/${r.habits.planned}</div><div class="stat-sub">habits completed</div></div>
          </div>${bars(r.completed_by_day)}`;
        return;
      }
      const q = { today: `status=todo&to=${t}`, week: `status=todo&from=${t}&to=${plus7}`, overdue: 'overdue=true', all: 'status=todo', done: 'status=done' }[tab];
      let rows = await api(`/api/tasks?${q}`);
      if (tab === 'done') rows = rows.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? '')).slice(0, 100);
      pane.innerHTML = taskList(rows, { today: 'Nothing due today.', overdue: 'Nothing missed. Great job!', done: 'No completed tasks yet.' }[tab] ?? 'No tasks.');
    }
    loadPane();
  },

  async chat(view, arg) {
    if (arg) state.convId = Number(arg) || null;
    const convs = await api('/api/conversations');
    view.innerHTML = `
      <div class="chat">
        <div class="chat-list card" style="padding:10px">
          <button class="btn small" id="newChat" style="margin-bottom:8px">+ New chat</button>
          ${convs.map((c) => `<a href="#/chat/${c.id}" class="${c.id === state.convId ? 'on' : ''}" title="${esc(c.title)}">${esc(c.title)}</a>`).join('') || '<div class="muted small">No chats yet</div>'}
        </div>
        <div class="chat-main">
          <div class="messages" id="msgs"></div>
          <div class="suggestions" id="sugg">
            ${['Plan my day tomorrow', 'Remind me to pay electricity next Friday', 'What important tasks have I missed?', 'Organise my tasks by priority', 'How did I go this week?']
              .map((s) => `<button>${s}</button>`).join('')}
          </div>
          <form class="composer" id="composer">
            <textarea id="msgIn" rows="1" placeholder="${state.me.ai_configured ? 'Ask your agent anything…' : 'AI is off: add ANTHROPIC_API_KEY to .env and restart'}" ${state.me.ai_configured ? '' : 'disabled'}></textarea>
            <button class="btn" type="submit" ${state.me.ai_configured ? '' : 'disabled'}>Send</button>
          </form>
        </div>
      </div>`;
    const msgs = $('#msgs');
    $('#newChat').onclick = () => { state.convId = null; location.hash = '#/chat'; route(); };
    $('#sugg').onclick = (e) => { if (e.target.tagName === 'BUTTON' && state.me.ai_configured) send(e.target.textContent); };
    const input = $('#msgIn');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
    $('#composer').onsubmit = (e) => { e.preventDefault(); const v = input.value.trim(); if (v) { input.value = ''; send(v); } };

    function bubble(role, text, tools = []) {
      const div = document.createElement('div');
      div.className = `msg ${role}`;
      div.innerHTML = (role === 'user' ? `<p>${esc(text).replace(/\n/g, '<br>')}</p>` : md(text || '(no text)'))
        + (tools.length ? `<div class="tool-chips">${tools.map((t) => `<span class="tool-chip">${esc(t)}</span>`).join('')}</div>` : '');
      msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
      return div;
    }
    function approvalCard(p) {
      const div = document.createElement('div');
      div.className = 'approval';
      const decided = p.status !== 'pending';
      div.innerHTML = `<div><b>Approval needed</b> · ${esc(p.summary)}</div>
        <div class="row">${decided ? `<span class="pill">${esc(p.status)}</span>` : '<button class="btn small" data-ok="1">Approve</button><button class="btn small ghost" data-ok="0">Reject</button>'}</div>`;
      div.onclick = async (e) => {
        const b = e.target.closest('button[data-ok]'); if (!b) return;
        try {
          const r = await api(`/api/approvals/${p.id}`, { method: 'POST', body: { approve: b.dataset.ok === '1' } });
          div.querySelector('.row').innerHTML = `<span class="pill">${esc(r.status)}</span>`;
          toast(r.status === 'approved' ? 'Approved and done.' : r.status === 'rejected' ? 'Rejected. Nothing was changed.' : 'Approval failed to run.');
        } catch (err) { toast(err.message); }
      };
      msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
    }

    if (state.convId) {
      const c = await api(`/api/conversations/${state.convId}`);
      c.messages.forEach((m) => bubble(m.role, m.text, m.tools));
      c.pending.slice().reverse().forEach(approvalCard);
    } else {
      bubble('assistant', `Hi ${state.me.display_name}! I can plan your day, add reminders, reschedule and prioritise tasks, review your week and remember your preferences. What would you like to do?`);
    }
    if (state.pendingPrompt && state.me.ai_configured) { const p = state.pendingPrompt; state.pendingPrompt = null; send(p); }

    async function send(text) {
      bubble('user', text);
      const typing = document.createElement('div'); typing.className = 'typing'; typing.textContent = 'Thinking…'; msgs.appendChild(typing);
      $('#composer button').disabled = true;
      try {
        const r = await api('/api/chat', { method: 'POST', body: { message: text, conversationId: state.convId ?? undefined } });
        typing.remove();
        const isNew = !state.convId;
        state.convId = r.conversationId;
        bubble('assistant', r.reply, r.actions.map((a) => `${a.status === 'ok' ? '✓' : a.status === 'pending_approval' ? '⏳' : '✕'} ${a.summary}`));
        const pend = r.actions.filter((a) => a.status === 'pending_approval');
        if (pend.length) {
          const all = await api(`/api/conversations/${r.conversationId}`);
          all.pending.filter((p) => pend.some((a) => a.pendingActionId === p.id)).forEach(approvalCard);
        }
        if (isNew) history.replaceState(null, '', `#/chat/${r.conversationId}`);
      } catch (err) {
        typing.remove();
        bubble('assistant', `⚠️ ${err.message}`);
      } finally { $('#composer button').disabled = false; }
    }
  },

  async memory(view) {
    const items = await api('/api/memory');
    const cats = ['preference', 'goal', 'budget', 'bill', 'schedule', 'content_style', 'project', 'other'];
    view.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <p class="muted small" style="margin-top:0">This is everything your agent remembers about you. You can add, edit, export or delete any of it. Passwords, card numbers, bank account numbers and tax file numbers are refused automatically.</p>
        <form id="memForm" class="form-grid">
          <label>Category<select name="category">${cats.map((c) => `<option>${c}</option>`).join('')}</select></label>
          <label>Name<input name="key" placeholder="e.g. deep work time" required maxlength="100"></label>
          <label class="wide">Value<input name="value" placeholder="e.g. 8–11 am on weekdays" required maxlength="2000"></label>
          <button class="btn">Save</button>
        </form>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:8px"><h2 style="margin:0">Saved memory (${items.length})</h2><span class="spacer"></span>
          <a class="btn small ghost" href="/api/memory/export" download>Export JSON</a>
          <button class="btn small danger" id="memWipe" ${items.length ? '' : 'disabled'}>Delete all</button></div>
        <div class="table-wrap"><table><thead><tr><th>Category</th><th>Name</th><th>Value</th><th>Source</th><th></th></tr></thead><tbody>
        ${items.map((m) => `<tr data-id="${m.id}"><td><span class="pill">${esc(m.category)}</span></td><td>${esc(m.key)}</td><td>${esc(m.value)}</td><td class="small muted">${m.source === 'agent' ? 'AI' : 'You'} · ${auDateTime(m.updated_at)}</td>
          <td style="white-space:nowrap"><button class="btn small ghost" data-act="edit">Edit</button> <button class="btn small danger" data-act="del">✕</button></td></tr>`).join('')
          || '<tr><td colspan="5" class="empty">Nothing saved yet. Tell the agent something like "Remember that I prefer workouts at 6 am".</td></tr>'}
        </tbody></table></div>
      </div>`;
    $('#memForm').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/api/memory', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Saved.'); route(); } catch (err) { toast(err.message); }
    };
    $('#memWipe').onclick = async () => { if (confirm('Delete ALL saved memory? This cannot be undone.')) { await api('/api/memory', { method: 'DELETE' }); route(); } };
    view.querySelector('tbody').onclick = async (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const id = b.closest('tr').dataset.id;
      const item = items.find((m) => String(m.id) === id);
      try {
        if (b.dataset.act === 'del') { await api(`/api/memory/${id}`, { method: 'DELETE' }); route(); }
        else {
          const value = prompt(`Edit "${item.key}"`, item.value);
          if (value !== null && value.trim()) { await api(`/api/memory/${id}`, { method: 'PUT', body: { category: item.category, key: item.key, value } }); route(); }
        }
      } catch (err) { toast(err.message); }
    };
  },

  async settings(view) {
    const [perms, auditRows, sessions] = await Promise.all([api('/api/permissions'), api('/api/audit'), api('/api/auth/sessions')]);
    view.innerHTML = `
      <div class="grid">
        <div class="card">
          <h2>AI model</h2>
          <p style="margin:0">${state.me.ai_configured ? `Connected · <code>${esc(state.me.ai_model)}</code>` : '<span style="color:var(--warn)">Not configured.</span> Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart the server.'}</p>
          <p class="small muted" style="margin:6px 0 0">The API key is stored only on the server and never sent to your browser.</p>
        </div>
        <div class="card">
          <h2>AI tool permissions</h2>
          <p class="small muted" style="margin-top:0"><b>Allow</b> runs straight away. <b>Ask me</b> waits for you to approve it in the chat. <b>Block</b> stops the AI using it. Every tool call is recorded in the audit log.</p>
          <div class="table-wrap"><table><tbody>
          ${perms.map((p) => `<tr><td><code>${esc(p.tool)}</code><div class="small muted">${esc(p.description)}</div></td>
            <td style="width:150px"><select data-tool="${esc(p.tool)}">
              ${[['allow', 'Allow'], ['approve', 'Ask me'], ['deny', 'Block']].map(([v, l]) => `<option value="${v}" ${p.mode === v ? 'selected' : ''} ${p.always_require_approval && v === 'allow' ? 'disabled' : ''}>${l}</option>`).join('')}
            </select></td></tr>`).join('')}
          </tbody></table></div>
        </div>
        <div class="card">
          <h2>Connected accounts</h2>
          <p class="small muted" style="margin:0">None yet. Calendar, social media publishing and open-banking connections are added in Phase 5 using official OAuth. Your banking passwords are never requested or stored.</p>
        </div>
        <div class="grid cols-2">
          <div class="card">
            <h2>Change password</h2>
            <form id="pwForm" style="display:grid;gap:10px">
              <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
              <label>New password (12+ characters)<input type="password" name="next" minlength="12" autocomplete="new-password" required></label>
              <button class="btn">Update password</button>
            </form>
          </div>
          <div class="card">
            <h2>Signed-in devices (${sessions.length})</h2>
            ${sessions.map((s) => `<div class="small" style="padding:5px 0;border-bottom:1px solid var(--line)">${esc((s.user_agent || 'Unknown device').slice(0, 70))}${s.current ? ' <span class="pill">this device</span>' : ''}<div class="muted">Since ${auDateTime(s.created_at)}</div></div>`).join('')}
            <button class="btn small ghost" id="revoke" style="margin-top:10px" ${sessions.length > 1 ? '' : 'disabled'}>Sign out other devices</button>
          </div>
        </div>
        <div class="card">
          <h2>Audit log (latest 200)</h2>
          <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>
          ${auditRows.map((a) => `<tr><td class="small" style="white-space:nowrap">${auDateTime(a.created_at)}</td><td><span class="pill">${esc(a.actor)}</span></td><td>${esc(a.action)}</td><td><code>${esc(JSON.stringify(a.detail)).slice(0, 220)}</code></td></tr>`).join('')}
          </tbody></table></div>
        </div>
      </div>`;
    view.querySelectorAll('select[data-tool]').forEach((s) => s.onchange = async () => {
      try { await api(`/api/permissions/${s.dataset.tool}`, { method: 'PUT', body: { mode: s.value } }); toast('Permission updated.'); } catch (err) { toast(err.message); route(); }
    });
    $('#pwForm').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/api/auth/change-password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Password changed. Other devices were signed out.'); }
      catch (err) { toast(err.message); }
    };
    $('#revoke').onclick = async () => { await api('/api/auth/sessions/revoke-others', { method: 'POST' }); route(); };
  },
};

const COMING = {
  finance: ['Manual income and expense entry, plus CSV import from your bank', 'Automatic spending categories', 'Weekly and monthly budgets in AUD', 'Recurring bills and subscriptions with due-date reminders', 'Debt repayment tracking', '"How much can I safely spend this week?" answered from your real data'],
  goals: ['Goals such as "Save $10,000 in six months" or an emergency fund', 'Monthly and weekly targets calculated from your actual income and spending', 'Progress charts and behind-schedule warnings', 'Milestone reminders'],
  social: ['Weekly content plans, ideas, captions, hashtags and video scripts', 'Previews you approve or send back for changes', 'Scheduling and publishing only through official APIs or approved services', 'Performance tracking where analytics access is available'],
  automations: ['7:00 am morning briefing, 1:00 pm check-in, 8:00 pm evening review', 'Runs on a real server-side scheduler, so you don\'t need a window open', 'Reminder notifications', 'Every automatic action respects your permission settings'],
};
function comingSoon(section) {
  $('#view').innerHTML = `<div class="card coming"><span class="pill">Phase ${section.phase}</span>
    <h3 style="margin-top:10px">${esc(section.label)} is not built yet</h3>
    <p class="muted">This section is part of Phase ${section.phase}. Nothing here is active, so no data is shown. It will include:</p>
    <ul>${(COMING[section.id] ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
}

boot().catch((err) => { document.body.innerHTML = `<p style="padding:20px">Could not reach the server: ${esc(err.message)}</p>`; });
