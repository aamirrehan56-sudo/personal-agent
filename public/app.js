// Personal Agent dashboard. Plain JavaScript modules, no build step needed.
const TZ = 'Australia/Melbourne';
const $ = (sel, el = document) => el.querySelector(sel);

const SECTIONS = [
  { id: 'home', label: 'Home', ico: '◎', tab: true },
  { id: 'chat', label: 'AI Chat', ico: '✦', tab: true },
  { id: 'tasks', label: 'Tasks', ico: '☑', tab: true },
  { id: 'finance', label: 'Finance', ico: '$', tab: true },
  { id: 'goals', label: 'Goals', ico: '★' },
  { id: 'social', label: 'Social Studio', ico: '▶', phase: 3 },
  { id: 'automations', label: 'Automations', ico: '⟳', phase: 4 },
  { id: 'memory', label: 'Memory', ico: '◈' },
  { id: 'settings', label: 'Settings', ico: '⚙' },
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
    <a class="${s.id === active ? 'active' : ''}" href="#/${s.id}"><span class="ico">${s.ico}</span>${esc(s.label.replace('AI ', ''))}</a>`).join('')
    + `<a href="#" id="moreTab" class="${SECTIONS.find((s) => s.id === active && !s.tab) ? 'active' : ''}"><span class="ico">☰</span>More</a>`;
  $('#moreTab').onclick = (e) => { e.preventDefault(); $('#shell').classList.add('menu-open'); };
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
        <div class="grid cols-3">
          <a class="card link-card" href="#/finance"><h2>Safe to spend this week</h2><div class="stat">${aud(h.safe_to_spend.safe_to_spend_cents, { whole: true })}</div>
            <div class="stat-sub">${h.safe_to_spend.shortfall_cents ? `<span style="color:var(--bad)">Over by ${aud(h.safe_to_spend.shortfall_cents)} this week</span>` : h.safe_to_spend.warnings.length ? esc(h.safe_to_spend.warnings[0]) : `About ${aud(h.safe_to_spend.per_day_cents, { whole: true })} a day until Sunday`}</div></a>
          <a class="card link-card" href="#/finance/bills"><h2>Bills due in 7 days</h2>${h.upcoming_bills.length ? h.upcoming_bills.slice(0, 4).map((b) => `<div class="row small" style="padding:3px 0"><span>${esc(b.name)}</span><span class="spacer"></span><span class="muted">${relDay(b.next_due)}</span><b>${aud(b.amount_cents, { whole: true })}</b></div>`).join('') : '<div class="empty">No bills due this week.</div>'}</a>
          <a class="card link-card" href="#/goals"><h2>Savings goals</h2>${h.goals.length ? h.goals.slice(0, 3).map((g) => `<div style="padding:3px 0"><div class="row small"><span>${esc(g.name)}</span><span class="spacer"></span>${goalPill(g.plan.status)}</div><div class="hbar-track"><i style="width:${g.plan.percent}%"></i></div></div>`).join('') : '<div class="empty">No goals yet.</div>'}</a>
        </div>
        ${h.pending_approvals.length ? `<div class="card"><h2>Waiting for your approval</h2>${h.pending_approvals.map((p) => `<div class="row" style="padding:6px 0"><span>${esc(p.summary)}</span><span class="spacer"></span><a class="btn small ghost" href="#/chat/${p.conversation_id ?? ''}">Review</a></div>`).join('')}</div>` : ''}
        <div class="grid cols-2">
          <div class="card" id="homeToday"><h2>Today</h2>${taskList([...o.overdue, ...o.due_today], 'Nothing due today. Enjoy it, or add a task.')}</div>
          <div class="card"><h2>Completed this week</h2>${bars(h.week.completed_by_day)}
            <p class="small muted" style="margin:10px 0 0">Habits: ${h.week.habits.done} done of ${h.week.habits.planned} planned.</p></div>
        </div>
        <div class="card"><h2>Coming next</h2><p class="muted small" style="margin:0">Social Studio arrives in Phase 3 and the automatic 7 am / 1 pm / 8 pm briefings in Phase 4. Those sections are marked in the menu and are not active yet.</p></div>
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
            ${['How much can I safely spend this week?', 'Plan my day tomorrow', 'Remind me to pay electricity next Friday', 'Am I on track with my savings goals?', 'Where can I cut back on spending?', 'What important tasks have I missed?']
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
      bubble('assistant', `Hi ${state.me.display_name}! I can plan your day, manage tasks and reminders, record spending, track bills, budgets and savings goals, tell you what's safe to spend, and remember your preferences. What would you like to do?`);
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

// ---------- money helpers ----------
function aud(cents, opts = {}) {
  if (cents === null || cents === undefined) return '–';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: opts.whole ? 0 : 2, minimumFractionDigits: opts.whole ? 0 : 2 }).format(cents / 100);
}
function toCents(v) {
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
function addDaysIso(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function hbars(items, { value, label, max, marker, color } = {}) {
  const top = max ?? Math.max(1, ...items.map(value));
  return `<div class="hbars">${items.map((it) => {
    const v = value(it); const pct = Math.min(100, (v / top) * 100);
    const m = marker ? marker(it) : null;
    return `<div class="hbar"><div class="hbar-top"><span>${label(it)}</span></div>
      <div class="hbar-track"><i style="width:${pct}%;${color ? `background:${color(it)}` : ''}"></i>${m !== null && m !== undefined ? `<b class="hbar-mark" style="left:${Math.min(100, (m / top) * 100)}%"></b>` : ''}</div></div>`;
  }).join('')}</div>`;
}
function columnChart(points, { value, label, height = 120 } = {}) {
  const max = Math.max(1, ...points.map(value));
  const w = 100 / Math.max(points.length, 1);
  return `<svg class="colchart" viewBox="0 0 100 ${height / 3}" preserveAspectRatio="none" role="img" aria-label="Daily spending">
    ${points.map((p, i) => { const h = (value(p) / max) * (height / 3 - 1); return `<rect x="${i * w + w * 0.15}" y="${height / 3 - h}" width="${w * 0.7}" height="${Math.max(h, value(p) ? 0.6 : 0.2)}" rx="0.6"><title>${esc(label(p))}</title></rect>`; }).join('')}
  </svg>`;
}
function lineChart(series, { from, to, target }) {
  // Cumulative saved amount over time, with the straight "on-track" line from start to target date.
  // Labels are HTML (not SVG text) so they stay readable at any screen width.
  const W = 600, H = 160, P = 6;
  const end = to ?? addDaysIso(todayIso(), 30);
  const t0 = Date.parse(from), t1 = Date.parse(end);
  const X = (d) => P + ((Date.parse(d) - t0) / Math.max(1, t1 - t0)) * (W - P * 2);
  const max = Math.max(target, ...series.map((s) => s.saved_cents)) || 1;
  const Y = (c) => H - P - (c / max) * (H - P * 2);
  const pts = series.length ? [{ date: from, saved_cents: series[0].date === from ? series[0].saved_cents : 0 }, ...series] : [];
  const today = todayIso();
  if (pts.length && today > pts.at(-1).date && today <= end) pts.push({ date: today, saved_cents: pts.at(-1).saved_cents });
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.date).toFixed(1)} ${Y(p.saved_cents).toFixed(1)}`).join(' ');
  const start = pts[0]?.saved_cents ?? 0;
  return `<svg class="linechart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Goal progress chart">
    <line x1="${P}" x2="${W - P}" y1="${Y(target)}" y2="${Y(target)}" class="lc-target" vector-effect="non-scaling-stroke"/>
    ${to ? `<line x1="${X(from)}" y1="${Y(start)}" x2="${X(to)}" y2="${Y(target)}" class="lc-ideal" vector-effect="non-scaling-stroke"/>` : ''}
    <path d="${path}" class="lc-actual" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="row small muted" style="justify-content:space-between"><span>${auDate(from)}</span><span>${to ? auDate(to) : ''}</span></div>
  <div class="small muted row" style="gap:16px"><span><i class="key key-actual"></i>Saved</span>${to ? '<span><i class="key key-ideal"></i>On-track line</span>' : ''}<span><i class="key key-target"></i>Target ${aud(target, { whole: true })}</span></div>`;
}
const GOAL_STATUS = { on_track: ['On track', 'good'], ahead: ['Ahead', 'good'], behind: ['Behind', 'bad'], achieved: ['Achieved', 'good'], no_deadline: ['No deadline', ''], overdue: ['Past target date', 'bad'] };
function goalPill(status) { const [l, c] = GOAL_STATUS[status] ?? [status, '']; return `<span class="pill ${c}">${l}</span>`; }
function freqLabel(f) { return { weekly: 'weekly', fortnightly: 'fortnightly', monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly', once: 'once' }[f] ?? f; }

VIEWS.finance = async (view, arg) => {
  const tabs = { overview: 'Overview', transactions: 'Transactions', import: 'Import CSV', budgets: 'Budgets', bills: 'Bills', debts: 'Debts', reports: 'Reports' };
  const tab = tabs[arg] ? arg : 'overview';
  const meta = state.financeMeta ?? (state.financeMeta = await api('/api/finance/meta'));
  const catOptions = (sel) => meta.categories.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('');
  view.innerHTML = `<div class="tabs" id="finTabs">${Object.entries(tabs).map(([k, v]) => `<button data-href="#/finance/${k}" class="${k === tab ? 'on' : ''}">${v}</button>`).join('')}</div><div id="fin"></div>`;
  $('#finTabs').onclick = (e) => { const b = e.target.closest('[data-href]'); if (b) location.hash = b.dataset.href; };
  const el = $('#fin');
  const reload = () => VIEWS.finance(view, tab);

  if (tab === 'overview') {
    const o = await api('/api/finance/overview');
    const s = o.safe_to_spend; const m = o.month;
    const inc = o.income_setting;
    el.innerHTML = `
      <div class="grid">
        <div class="grid cols-2">
          <div class="card hero">
            <h2>Safe to spend this week</h2>
            <div class="stat">${aud(s.safe_to_spend_cents, { whole: true })}</div>
            <div class="stat-sub">${s.shortfall_cents ? `<span style="color:var(--bad)">Over by ${aud(s.shortfall_cents)}</span>` : `About ${aud(s.per_day_cents, { whole: true })} a day for the ${s.days_left_in_week} day${s.days_left_in_week === 1 ? '' : 's'} left (to ${auDate(s.week_end)})`}</div>
            <table class="small" style="margin-top:12px"><tbody>
              <tr><td>Weekly income <span class="muted">(${esc(s.income_source)})</span></td><td style="text-align:right">${aud(s.weekly_income_cents)}</td></tr>
              <tr><td>Bills set aside</td><td style="text-align:right">−${aud(s.bills_weekly_cents)}</td></tr>
              <tr><td>Debt repayments</td><td style="text-align:right">−${aud(s.debt_repayments_weekly_cents)}</td></tr>
              <tr><td>Savings goals</td><td style="text-align:right">−${aud(s.goal_targets_weekly_cents)}</td></tr>
              <tr><td>Already spent this week</td><td style="text-align:right">−${aud(s.flexible_spent_this_week_cents)}</td></tr>
            </tbody></table>
            ${s.warnings.map((w) => `<p class="small" style="color:var(--warn);margin:8px 0 0">${esc(w)}</p>`).join('')}
          </div>
          <div class="card">
            <h2>Your take-home pay</h2>
            <p class="small muted" style="margin-top:0">Used until you have 4+ weeks of transactions. After that, real income is used.</p>
            <form id="incomeForm" class="row">
              <input name="amount" inputmode="decimal" placeholder="e.g. 2,400" value="${inc?.income_cents != null ? (inc.income_cents / 100).toFixed(2) : ''}" style="width:130px" required>
              <select name="freq">${['weekly', 'fortnightly', 'monthly'].map((f) => `<option ${inc?.income_frequency === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
              <button class="btn">Save</button>
            </form>
            <h2 style="margin-top:18px">Savings capacity</h2>
            <div class="stat" style="font-size:24px">${o.savings_capacity.monthly_cents === null ? '–' : `${aud(o.savings_capacity.monthly_cents, { whole: true })}<span class="stat-sub"> / month</span>`}</div>
            <div class="small muted">${esc(o.savings_capacity.basis)}</div>
          </div>
        </div>
        <div class="grid cols-3">
          <div class="card"><h2>Income · ${auDate(m.from, { month: 'long' })}</h2><div class="stat" style="color:var(--good)">${aud(m.income_cents, { whole: true })}</div><div class="stat-sub">Last month ${aud(m.previous.income_cents, { whole: true })}</div></div>
          <div class="card"><h2>Spending</h2><div class="stat">${aud(m.expenses_cents, { whole: true })}</div><div class="stat-sub">Last month ${aud(m.previous.expenses_cents, { whole: true })}</div></div>
          <div class="card"><h2>Net</h2><div class="stat" style="color:${m.net_cents < 0 ? 'var(--bad)' : 'inherit'}">${aud(m.net_cents, { whole: true })}</div><div class="stat-sub">${m.savings_rate !== null ? `Savings rate ${m.savings_rate}%` : 'No income recorded this month'}</div></div>
        </div>
        <div class="grid cols-2">
          <div class="card"><h2>Spending by category this month</h2>${m.by_category.length ? hbars(m.by_category.slice(0, 10), { value: (c) => c.spent_cents, label: (c) => `${esc(c.category)} <b>${aud(c.spent_cents, { whole: true })}</b>` }) : '<div class="empty">No spending recorded this month. Add a transaction or import a CSV.</div>'}</div>
          <div class="card"><h2>Daily spending this month</h2>${columnChart(m.daily_spending, { value: (d) => d.spent_cents, label: (d) => `${auDate(d.date)}: ${aud(d.spent_cents)}` })}
            <div class="row small muted" style="justify-content:space-between"><span>${auDate(m.from)}</span><span>${auDate(m.to)}</span></div></div>
        </div>
        <div class="grid cols-2">
          <div class="card"><h2>Bills due in the next 14 days</h2>${o.upcoming_bills.length ? o.upcoming_bills.map((b) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${esc(b.name)}</span>${b.overdue ? '<span class="pill overdue">overdue</span>' : b.reminder_due ? '<span class="pill high">due soon</span>' : ''}<span class="spacer"></span><span class="muted small">${relDay(b.next_due)}</span><b>${aud(b.amount_cents)}</b></div>`).join('') : '<div class="empty">Nothing due. Add bills in the Bills tab.</div>'}</div>
          <div class="card"><h2>Budgets</h2>${o.budgets.length ? o.budgets.map((b) => `<div style="padding:4px 0"><div class="hbar-top"><span>${esc(b.category)} <span class="muted">(${b.period})</span></span><span><b>${aud(b.spent_cents, { whole: true })}</b> of ${aud(b.amount_cents, { whole: true })}</span></div>
            <div class="hbar-track"><i style="width:${Math.min(100, b.percent_used)}%;background:${b.over_budget ? 'var(--bad)' : b.percent_used > 80 ? 'var(--warn)' : 'var(--accent)'}"></i></div></div>`).join('') : '<div class="empty">No budgets yet. Set them in the Budgets tab, or ask the AI.</div>'}</div>
        </div>
      </div>`;
    $('#incomeForm').onsubmit = async (e) => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
      const c = toCents(f.amount); if (!(c >= 0)) return toast('Enter an amount like 2400 or 2,400.50');
      try { await api('/api/finance/income', { method: 'PUT', body: { income_cents: c, income_frequency: f.freq } }); toast('Saved.'); reload(); } catch (err) { toast(err.message); }
    };
  }

  if (tab === 'transactions') {
    const month = state.finMonth ?? todayIso().slice(0, 7);
    const from = `${month}-01`; const to = addDaysIso(`${new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10)}`, -1);
    const rows = await api(`/api/finance/transactions?from=${from}&to=${to}`);
    el.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <form id="txForm" class="form-grid">
          <label class="wide">Description<input name="description" placeholder="e.g. Coles groceries" required maxlength="300"></label>
          <label>Amount ($)<input name="amount" inputmode="decimal" placeholder="45.50" required></label>
          <label>Type<select name="type"><option value="out">Money out</option><option value="in">Money in</option></select></label>
          <label>Date<input name="date" type="date" value="${todayIso()}" required></label>
          <label>Category<select name="category"><option value="">Automatic</option>${catOptions()}</select></label>
          <button class="btn">Add</button>
        </form>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:8px"><input type="month" id="finMonth" value="${month}"><span class="spacer"></span>
          <span class="small muted">${rows.length} transactions · in ${aud(rows.filter((r) => r.kind === 'income').reduce((s, r) => s + r.amount_cents, 0))} · out ${aud(-rows.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.amount_cents, 0))}</span></div>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th><th></th></tr></thead><tbody id="txBody">
        ${rows.map((t) => `<tr data-id="${t.id}"><td class="small" style="white-space:nowrap">${auDate(t.date)}</td><td>${esc(t.description)}${t.source !== 'manual' ? ` <span class="small muted">· ${esc(t.source)}</span>` : ''}</td>
          <td><select data-cat style="max-width:170px">${catOptions(t.category)}</select></td>
          <td style="text-align:right;white-space:nowrap;color:${t.amount_cents > 0 ? 'var(--good)' : 'inherit'}">${t.amount_cents > 0 ? '+' : ''}${aud(t.amount_cents)}</td>
          <td><button class="btn small danger" data-del>✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No transactions this month.</td></tr>'}
        </tbody></table></div>
      </div>`;
    $('#finMonth').onchange = (e) => { state.finMonth = e.target.value; reload(); };
    $('#txForm').onsubmit = async (e) => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
      const c = toCents(f.amount); if (!(c > 0)) return toast('Enter a positive amount, e.g. 45.50');
      try {
        const t = await api('/api/finance/transactions', { method: 'POST', body: { description: f.description, amount_cents: f.type === 'in' ? c : -c, date: f.date, ...(f.category ? { category: f.category } : {}) } });
        toast(`Added as ${t.category}.`); reload();
      } catch (err) { toast(err.message); }
    };
    $('#txBody').onchange = async (e) => {
      if (!e.target.matches('[data-cat]')) return;
      const id = e.target.closest('tr').dataset.id;
      const remember = confirm('Always use this category for similar transactions? (OK = yes, Cancel = just this one)');
      try { await api(`/api/finance/transactions/${id}`, { method: 'PATCH', body: { category: e.target.value, remember } }); toast(remember ? 'Updated, and remembered for next time.' : 'Updated.'); } catch (err) { toast(err.message); }
    };
    $('#txBody').onclick = async (e) => {
      if (!e.target.matches('[data-del]')) return;
      if (!confirm('Delete this transaction?')) return;
      await api(`/api/finance/transactions/${e.target.closest('tr').dataset.id}`, { method: 'DELETE' }); reload();
    };
  }

  if (tab === 'import') {
    el.innerHTML = `<div class="card">
      <h2>Import a CSV from your bank</h2>
      <p class="small muted" style="margin-top:0">In your bank's app or website, export transactions as CSV (CommBank, NAB, ANZ, Westpac, ING and others all offer this). Your bank login is never needed. Importing the same file twice won't create duplicates.</p>
      <input type="file" id="csvFile" accept=".csv,text/csv">
      <div id="csvPreview"></div></div>`;
    $('#csvFile').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 2_000_000) return toast('That file is over 2 MB. Export a shorter date range.');
      const csv = await file.text();
      try {
        const p = await api('/api/finance/import/preview', { method: 'POST', body: { csv } });
        const g = p.guess;
        const colSel = (name, sel, optional) => `<label>${name}<select name="${name.toLowerCase()}">${optional ? '<option value="">(none)</option>' : ''}${p.header.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`;
        $('#csvPreview').innerHTML = `
          <p>${p.total_rows} rows found. Check the columns, then import.</p>
          <form id="mapForm" class="form-grid">
            ${colSel('Date', g.date)}${colSel('Description', g.description)}${colSel('Amount', g.amount, true)}${colSel('Debit', g.debit, true)}${colSel('Credit', g.credit, true)}
            <label style="flex-direction:row;display:flex;gap:8px;align-items:center"><input type="checkbox" name="hasHeader" ${g.hasHeader ? 'checked' : ''}> First row is a header</label>
            <label style="flex-direction:row;display:flex;gap:8px;align-items:center"><input type="checkbox" name="invert"> Spending shows as positive</label>
            <button class="btn">Import ${p.total_rows} rows</button>
          </form>
          <div class="table-wrap" style="margin-top:12px"><table><thead><tr>${p.header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
          ${p.sample.map((r) => `<tr>${r.map((c) => `<td class="small">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        $('#mapForm').onsubmit = async (ev) => {
          ev.preventDefault(); const f = new FormData(ev.target);
          const num = (k) => (f.get(k) === '' || f.get(k) === null ? undefined : Number(f.get(k)));
          const mapping = { hasHeader: f.get('hasHeader') === 'on', invert: f.get('invert') === 'on', date: num('date'), description: num('description'), amount: num('amount'), debit: num('debit'), credit: num('credit') };
          if (mapping.amount !== undefined) { delete mapping.debit; delete mapping.credit; }
          try {
            const r = await api('/api/finance/import', { method: 'POST', body: { csv, mapping } });
            $('#csvPreview').innerHTML = `<p><b>${r.imported}</b> imported, ${r.duplicates} already there, ${r.errors.length} skipped.</p>
              ${r.errors.slice(0, 10).map((x) => `<div class="small muted">Row ${x.row}: ${esc(x.error)}</div>`).join('')}
              <a class="btn" href="#/finance/transactions" style="margin-top:10px">See transactions</a>`;
          } catch (err) { toast(err.message); }
        };
      } catch (err) { toast(err.message); }
    };
  }

  if (tab === 'budgets') {
    const budgets = await api('/api/finance/budgets');
    el.innerHTML = `<div class="card" style="margin-bottom:16px">
      <form id="budForm" class="form-grid">
        <label>Category<select name="category">${catOptions('Eating out')}</select></label>
        <label>Period<select name="period"><option>weekly</option><option>monthly</option></select></label>
        <label>Amount ($)<input name="amount" inputmode="decimal" placeholder="100" required></label>
        <button class="btn">Save budget</button>
      </form></div>
      <div class="card">${budgets.length ? budgets.map((b) => `
        <div class="budget" data-id="${b.id}">
          <div class="row"><b>${esc(b.category)}</b><span class="muted small">${b.period}</span>${b.over_budget ? '<span class="pill overdue">over</span>' : ''}<span class="spacer"></span>
            <span class="small">${aud(b.spent_cents)} of ${aud(b.amount_cents)}</span><button class="btn small danger" data-del>✕</button></div>
          <div class="hbar-track"><i style="width:${Math.min(100, b.percent_used)}%;background:${b.over_budget ? 'var(--bad)' : b.percent_used > 80 ? 'var(--warn)' : 'var(--accent)'}"></i></div>
          <div class="small muted">${b.remaining_cents >= 0 ? `${aud(b.remaining_cents)} left` : `${aud(-b.remaining_cents)} over`} · ${auDate(b.from)} to ${auDate(b.to)}</div>
        </div>`).join('') : '<div class="empty">No budgets yet.</div>'}</div>`;
    $('#budForm').onsubmit = async (e) => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const c = toCents(f.amount);
      if (!(c > 0)) return toast('Enter an amount');
      try { await api('/api/finance/budgets', { method: 'PUT', body: { category: f.category, period: f.period, amount_cents: c } }); reload(); } catch (err) { toast(err.message); }
    };
    el.onclick = async (e) => { if (e.target.matches('[data-del]')) { await api(`/api/finance/budgets/${e.target.closest('.budget').dataset.id}`, { method: 'DELETE' }); reload(); } };
  }

  if (tab === 'bills') {
    const bills = await api('/api/finance/bills');
    const active = bills.filter((b) => b.active);
    el.innerHTML = `<div class="card" style="margin-bottom:16px">
      <p class="small muted" style="margin-top:0">Track bills and subscriptions to get reminders and set money aside. The app never pays anything: "Paid" just records that you paid.</p>
      <form id="billForm" class="form-grid">
        <label class="wide">Name<input name="name" placeholder="e.g. Electricity (AGL)" required></label>
        <label>Amount ($)<input name="amount" inputmode="decimal" required></label>
        <label>How often<select name="frequency">${['monthly', 'weekly', 'fortnightly', 'quarterly', 'yearly', 'once'].map((f) => `<option>${f}</option>`).join('')}</select></label>
        <label>Next due<input name="next_due" type="date" value="${todayIso()}" required></label>
        <label>Remind (days before)<input name="remind" type="number" min="0" max="30" value="3"></label>
        <label>Category<select name="category">${catOptions('Bills & Utilities')}</select></label>
        <label style="flex-direction:row;display:flex;gap:8px;align-items:center"><input type="checkbox" name="sub"> Subscription</label>
        <button class="btn">Add bill</button>
      </form></div>
      <div class="card"><div class="row" style="margin-bottom:6px"><h2 style="margin:0">Active bills (${active.length})</h2><span class="spacer"></span>
        <span class="small muted">Costs you ${aud(active.reduce((s, b) => s + b.monthly_equivalent_cents, 0))} a month · subscriptions ${aud(active.filter((b) => b.is_subscription).reduce((s, b) => s + b.monthly_equivalent_cents, 0))}/month</span></div>
      <div class="table-wrap"><table><thead><tr><th>Bill</th><th>Amount</th><th>Due</th><th></th></tr></thead><tbody>
      ${bills.map((b) => `<tr data-id="${b.id}" style="${b.active ? '' : 'opacity:.5'}"><td>${esc(b.name)}${b.is_subscription ? ' <span class="pill">subscription</span>' : ''}<div class="small muted">${esc(b.category)} · ${freqLabel(b.frequency)}</div></td>
        <td style="white-space:nowrap">${aud(b.amount_cents)}<div class="small muted">${aud(b.monthly_equivalent_cents)}/mo</div></td>
        <td style="white-space:nowrap">${b.active ? `${relDay(b.next_due)} ${b.overdue ? '<span class="pill overdue">overdue</span>' : b.reminder_due ? '<span class="pill high">soon</span>' : ''}` : 'Done'}${b.last_paid ? `<div class="small muted">Paid ${auDate(b.last_paid)}</div>` : ''}</td>
        <td style="white-space:nowrap">${b.active ? '<button class="btn small" data-paid>Paid</button>' : ''} <button class="btn small danger" data-del>✕</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No bills yet.</td></tr>'}
      </tbody></table></div></div>`;
    $('#billForm').onsubmit = async (e) => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const c = toCents(f.amount);
      if (!(c > 0)) return toast('Enter an amount');
      try { await api('/api/finance/bills', { method: 'POST', body: { name: f.name, amount_cents: c, frequency: f.frequency, next_due: f.next_due, category: f.category, is_subscription: f.sub === 'on', remind_days_before: Number(f.remind || 3) } }); toast('Bill added.'); reload(); } catch (err) { toast(err.message); }
    };
    el.onclick = async (e) => {
      const tr = e.target.closest('tr[data-id]'); if (!tr) return;
      try {
        if (e.target.matches('[data-paid]')) {
          const record = confirm('Also add this payment to your transactions? (OK = yes, Cancel = no, e.g. if it will come in with a CSV import)');
          const r = await api(`/api/finance/bills/${tr.dataset.id}/paid`, { method: 'POST', body: { record_transaction: record } });
          toast(r.bill.active ? `Recorded. Next due ${auDate(r.bill.next_due)}.` : 'Recorded.'); reload();
        }
        if (e.target.matches('[data-del]') && confirm('Delete this bill?')) { await api(`/api/finance/bills/${tr.dataset.id}`, { method: 'DELETE' }); reload(); }
      } catch (err) { toast(err.message); }
    };
  }

  if (tab === 'debts') {
    const debts = await api('/api/finance/debts');
    el.innerHTML = `<div class="card" style="margin-bottom:16px"><form id="debtForm" class="form-grid">
        <label class="wide">Name<input name="name" placeholder="e.g. Credit card" required></label>
        <label>Balance ($)<input name="balance" inputmode="decimal" required></label>
        <label>Interest (% a year)<input name="rate" inputmode="decimal" value="0" required></label>
        <label>Repayment ($)<input name="payment" inputmode="decimal" required></label>
        <label>How often<select name="freq"><option>monthly</option><option>fortnightly</option><option>weekly</option></select></label>
        <button class="btn">Add debt</button></form></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Debt</th><th>Balance</th><th>Repayment</th><th>Paid off in</th><th></th></tr></thead><tbody>
      ${debts.map((d) => `<tr data-id="${d.id}"><td>${esc(d.name)}<div class="small muted">${d.interest_rate}% a year</div></td><td>${aud(d.balance_cents)}</td>
        <td>${aud(d.min_payment_cents)} ${d.payment_frequency}</td>
        <td>${d.payoff_months === null ? `<span style="color:var(--bad)">${d.balance_cents ? 'Never at this rate' : '–'}</span>` : `${d.payoff_months} months<div class="small muted">${aud(d.total_interest_cents, { whole: true })} interest</div>`}</td>
        <td style="white-space:nowrap"><button class="btn small ghost" data-bal>Update balance</button> <button class="btn small danger" data-del>✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No debts recorded.</td></tr>'}
      </tbody></table></div><p class="small muted">Payoff times are estimates at the repayment you entered, with interest charged monthly.</p></div>`;
    $('#debtForm').onsubmit = async (e) => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
      try { await api('/api/finance/debts', { method: 'POST', body: { name: f.name, balance_cents: toCents(f.balance), interest_rate: Number(f.rate), min_payment_cents: toCents(f.payment), payment_frequency: f.freq } }); reload(); } catch (err) { toast(err.message); }
    };
    el.onclick = async (e) => {
      const tr = e.target.closest('tr[data-id]'); if (!tr) return;
      if (e.target.matches('[data-del]') && confirm('Delete this debt?')) { await api(`/api/finance/debts/${tr.dataset.id}`, { method: 'DELETE' }); reload(); }
      if (e.target.matches('[data-bal]')) { const v = prompt('New balance ($)'); if (v !== null) { await api(`/api/finance/debts/${tr.dataset.id}`, { method: 'PATCH', body: { balance_cents: toCents(v) } }); reload(); } }
    };
  }

  if (tab === 'reports') {
    const period = state.reportPeriod ?? 'week';
    const [r, ins] = await Promise.all([api(`/api/finance/report?period=${period}`), api('/api/finance/insights')]);
    const diff = (a, b) => { const d = a - b; return d === 0 ? '' : `<span class="small" style="color:${d > 0 ? 'var(--bad)' : 'var(--good)'}">${d > 0 ? '▲' : '▼'} ${aud(Math.abs(d), { whole: true })}</span>`; };
    el.innerHTML = `<div class="tabs"><button data-p="week" class="${period === 'week' ? 'on' : ''}">This week</button><button data-p="month" class="${period === 'month' ? 'on' : ''}">This month</button></div>
      <div class="grid">
        <div class="card"><h2>${auDate(r.from)} – ${auDate(r.to)}</h2>
          <div class="grid cols-3"><div><div class="stat" style="color:var(--good)">${aud(r.income_cents, { whole: true })}</div><div class="stat-sub">income (prev ${aud(r.previous.income_cents, { whole: true })})</div></div>
          <div><div class="stat">${aud(r.expenses_cents, { whole: true })}</div><div class="stat-sub">spent ${diff(r.expenses_cents, r.previous.expenses_cents)} vs previous</div></div>
          <div><div class="stat">${aud(r.net_cents, { whole: true })}</div><div class="stat-sub">${r.savings_rate !== null ? `saved ${r.savings_rate}% of income` : 'net'}</div></div></div>
          <div style="margin-top:14px">${columnChart(r.daily_spending, { value: (d) => d.spent_cents, label: (d) => `${auDate(d.date)}: ${aud(d.spent_cents)}` })}</div></div>
        <div class="card"><h2>By category</h2><div class="table-wrap"><table><thead><tr><th>Category</th><th style="text-align:right">Spent</th><th style="text-align:right">Previous</th></tr></thead><tbody>
          ${r.by_category.map((c) => `<tr><td>${esc(c.category)}</td><td style="text-align:right">${aud(c.spent_cents)}</td><td style="text-align:right" class="muted">${aud(c.previous_cents)} ${diff(c.spent_cents, c.previous_cents)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No spending in this period.</td></tr>'}
        </tbody></table></div></div>
        <div class="card"><h2>Worth a look (last 30 days)</h2>
          <p>Flexible spending: <b>${aud(ins.discretionary_last_30_days_cents)}</b>${ins.discretionary_by_category.length ? ` (${ins.discretionary_by_category.map((c) => `${esc(c.category)} ${aud(c.spent_cents, { whole: true })}`).join(', ')})` : ''}.</p>
          ${ins.top_discretionary_merchants.length ? `<p class="small muted" style="margin-bottom:4px">Top places</p>${ins.top_discretionary_merchants.map((m) => `<div class="small">${esc(m.name)}: ${aud(m.spent_cents)} over ${m.purchases} purchase${m.purchases === 1 ? '' : 's'}</div>`).join('')}` : ''}
          ${ins.categories_up_vs_previous_30_days.length ? `<p class="small muted" style="margin-bottom:4px">Up on the previous 30 days</p>${ins.categories_up_vs_previous_30_days.map((c) => `<div class="small">${esc(c.category)}: ${aud(c.last_30_days_cents)} (up ${aud(c.increase_cents)})</div>`).join('')}` : ''}
          ${ins.possible_subscriptions.length ? `<p class="small muted" style="margin-bottom:4px">Repeating charges not in your bills list</p>${ins.possible_subscriptions.map((s) => `<div class="small">${esc(s.name)}: about ${aud(s.typical_amount_cents)}, seen in ${s.months_seen} months</div>`).join('')}` : ''}
          ${ins.over_budget.length ? `<p class="small" style="color:var(--bad)">Over budget: ${ins.over_budget.map((b) => esc(b.category)).join(', ')}</p>` : ''}
          ${!ins.discretionary_by_category.length && !ins.possible_subscriptions.length ? '<div class="empty">Not enough transactions yet.</div>' : ''}
          <a class="btn small ghost" href="#/chat" data-prompt="Look at my spending for the last 30 days and suggest where I can cut back">Ask AI for suggestions</a></div>
      </div>`;
    el.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => { state.reportPeriod = b.dataset.p; reload(); });
    el.querySelectorAll('[data-prompt]').forEach((a) => a.addEventListener('click', () => { state.pendingPrompt = a.dataset.prompt; state.convId = null; }));
  }
};

VIEWS.goals = async (view) => {
  const goals = await api('/api/goals');
  const sixMonths = (() => { const d = new Date(`${todayIso()}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 6); return d.toISOString().slice(0, 10); })();
  view.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <form id="goalForm" class="form-grid">
        <label class="wide">Goal<input name="name" placeholder="e.g. Save $10,000" required maxlength="120"></label>
        <label>Type<select name="kind"><option value="savings">Savings</option><option value="emergency_fund">Emergency fund</option><option value="house_deposit">House deposit</option><option value="business">Business investment</option><option value="debt_payoff">Debt payoff</option><option value="other">Other</option></select></label>
        <label>Target ($)<input name="target" inputmode="decimal" placeholder="10000" required></label>
        <label>By<input name="date" type="date" value="${sixMonths}"></label>
        <label>Already saved ($)<input name="start" inputmode="decimal" placeholder="0"></label>
        <button class="btn">Create goal</button>
      </form>
    </div>
    <div class="grid" id="goalList">${goals.map((g) => `
      <div class="card goal" data-id="${g.id}">
        <div class="row"><h3 style="margin:0">${esc(g.name)}</h3>${goalPill(g.plan.status)}${g.status !== 'active' && g.status !== 'achieved' ? `<span class="pill">${esc(g.status)}</span>` : ''}<span class="spacer"></span>
          <span class="small muted">${g.target_date ? `by ${auDate(g.target_date, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'no deadline'}</span></div>
        <div class="row" style="margin:12px 0 6px;align-items:baseline"><span class="stat" style="font-size:26px">${aud(g.plan.saved_cents, { whole: true })}</span><span class="muted">of ${aud(g.target_cents, { whole: true })} · ${g.plan.percent}%</span></div>
        <div class="hbar-track big"><i style="width:${g.plan.percent}%"></i>${[25, 50, 75].map((m) => `<b class="hbar-mark" style="left:${m}%" title="${m}%"></b>`).join('')}</div>
        <div class="grid cols-3" style="margin-top:12px">
          <div><div class="stat-sub">Needed per week</div><b>${g.plan.required_weekly_cents === null ? '–' : aud(g.plan.required_weekly_cents)}</b></div>
          <div><div class="stat-sub">Needed per month</div><b>${g.plan.required_monthly_cents === null ? '–' : aud(g.plan.required_monthly_cents)}</b></div>
          <div><div class="stat-sub">${g.plan.status === 'behind' ? 'Behind by' : 'Left to save'}</div><b style="${g.plan.status === 'behind' ? 'color:var(--bad)' : ''}">${aud(g.plan.status === 'behind' ? g.plan.behind_by_cents : g.plan.remaining_cents)}</b></div>
        </div>
        <div style="margin-top:12px">${lineChart(g.progress, { from: g.start_date, to: g.target_date, target: g.target_cents })}</div>
        <div class="advice small" data-advice></div>
        <form class="row contrib" style="margin-top:12px">
          <input name="amount" inputmode="decimal" placeholder="Amount ($)" style="width:130px" required>
          <button class="btn small">Add savings</button><button class="btn small ghost" type="button" data-withdraw>Withdraw</button>
          <span class="spacer"></span>
          <button class="btn small ghost" type="button" data-check>Is this realistic?</button>
          <button class="btn small danger" type="button" data-del>Delete</button>
        </form>
      </div>`).join('') || '<div class="card empty">No goals yet. Create one above, or tell the AI something like "I want to save $10,000 in six months".</div>'}
    </div>`;
  $('#goalForm').onsubmit = async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const t = toCents(f.target);
    if (!(t > 0)) return toast('Enter a target amount');
    const start = f.start ? toCents(f.start) : 0;
    try { await api('/api/goals', { method: 'POST', body: { name: f.name, kind: f.kind, target_cents: t, target_date: f.date || null, starting_amount_cents: start > 0 ? start : undefined } }); toast('Goal created.'); route(); } catch (err) { toast(err.message); }
  };
  const list = $('#goalList');
  const contribute = async (card, sign) => {
    const c = toCents(card.querySelector('[name=amount]').value);
    if (!(c > 0)) return toast('Enter an amount');
    try {
      const r = await api(`/api/goals/${card.dataset.id}/contributions`, { method: 'POST', body: { amount_cents: sign * c } });
      toast(r.milestones_reached.length ? `🎉 You reached ${r.milestones_reached.at(-1)}% of your goal!` : 'Recorded.'); route();
    } catch (err) { toast(err.message); }
  };
  list.addEventListener('submit', (e) => { e.preventDefault(); contribute(e.target.closest('.goal'), 1); });
  list.onclick = async (e) => {
    const card = e.target.closest('.goal'); if (!card) return;
    if (e.target.matches('[data-withdraw]')) contribute(card, -1);
    if (e.target.matches('[data-del]') && confirm('Delete this goal and its history?')) { await api(`/api/goals/${card.dataset.id}`, { method: 'DELETE' }); route(); }
    if (e.target.matches('[data-check]')) {
      const a = await api(`/api/goals/${card.dataset.id}/advice`);
      const label = { comfortable: ['Comfortable', 'var(--good)'], tight: ['Tight but possible', 'var(--warn)'], not_realistic: ['Needs changes to be realistic', 'var(--bad)'], achieved: ['Achieved', 'var(--good)'], unknown: ['Not enough data', 'var(--muted)'] }[a.feasibility];
      card.querySelector('[data-advice]').innerHTML = `<div class="advice-box">
        <b style="color:${label[1]}">${label[0]}</b>
        ${a.savings_capacity_monthly_cents !== null ? `<div>You can save about <b>${aud(a.savings_capacity_monthly_cents, { whole: true })}</b> a month (${esc(a.capacity_basis)}). After your other goals, <b>${aud(a.available_for_this_goal_monthly_cents, { whole: true })}</b> is left for this one; it needs <b>${a.plan.required_monthly_cents !== null ? aud(a.plan.required_monthly_cents, { whole: true }) : '–'}</b>.</div>` : ''}
        ${a.monthly_gap_cents ? `<div>Short by about ${aud(a.monthly_gap_cents, { whole: true })} a month.</div>` : ''}
        ${a.realistic_target_date && a.feasibility !== 'comfortable' ? `<div>At your current rate you'd reach it around <b>${auDate(a.realistic_target_date, { day: 'numeric', month: 'short', year: 'numeric' })}</b>.</div>` : ''}
        ${a.possible_cutbacks.length ? `<div>Cutting back 25% on ${a.possible_cutbacks.map((c) => `${esc(c.category)} (avg ${aud(c.monthly_average_cents, { whole: true })}/mo, save ${aud(c.suggested_cut_cents, { whole: true })})`).join(', ')} would help.</div>` : ''}
        ${a.suggestions.map((s) => `<div>${esc(s)}</div>`).join('')}</div>`;
    }
  };
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
