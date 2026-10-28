// Some browser contexts (privacy settings, embedded previews, or restricted origins) may deny
// access to localStorage. Keep the app usable for the current tab instead of crashing at startup.
const sessionStore = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { window.localStorage.setItem(key, value); return true; } catch { return false; } },
  clear() { try { window.localStorage.clear(); return true; } catch { return false; } }
};
let token = sessionStore.get('token'), user = null, meta = null;
try { user = JSON.parse(sessionStore.get('user') || 'null'); }
catch { sessionStore.clear(); token = null; user = null; }
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const cls = s => s.replace(/ /g, '-');
const badge = (s, k = '') => `<span class="badge ${k}${cls(s)}">${esc(s)}</span>`;
const handle = e => toast(e.message, 1);
const COLORS = { Low: '#5f8a66', Medium: '#9a7b0a', High: '#d9531e', Critical: '#b3261e' };
const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
// Approximate centre of Marwadi University, Rajkot. Building-level pins should be set by an admin.
const CENTER = [22.36758, 70.79573];

let tt;
function toast(m, err) {
  const t = $('toast'); t.textContent = m; t.className = err ? 'err' : ''; t.style.display = 'block';
  clearTimeout(tt); tt = setTimeout(() => t.style.display = 'none', 3500);
}
function logout() { sessionStore.clear(); token = null; user = null; location.hash = ''; boot(); }

async function api(url, opts = {}) {
  opts.headers = { ...(opts.headers || {}) };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (opts.body && !(opts.body instanceof FormData)) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
  let res; try { res = await fetch(url, opts); } catch { throw new Error('Network error: is the server running?'); }
  if (res.status === 401 && token) { logout(); throw new Error('Session expired, please log in again'); }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// ---------- landing + auth ----------
let signup = false;
function landing() {
  $('app').innerHTML = `<div class="hero"><div>
    <h1>Report it. Track it. Get it fixed.</h1>
    <p class="muted">CampusFix connects students with the staff who fix campus problems, with full transparency at every step.</p>
    <ol class="steps"><li>Report an issue with a location and photo</li><li>Upvote reports instead of duplicating them</li><li>Follow progress and confirm the fix</li></ol></div>
    <div class="card"><h2 id="aT">Login</h2>
      <div id="nameBox" class="hidden"><label for="aN">Full name</label><input id="aN" autocomplete="name"></div>
      <label for="aE">Email</label><input id="aE" type="email" autocomplete="email">
      <label for="aP">Password</label><input id="aP" type="password" autocomplete="current-password" maxlength="128">
      <button id="aB">Login</button>
      <p><a href="#" id="aS">New student? Create an account</a></p>
      <p class="muted" id="authHint">Sign in to report campus problems and track their progress.</p></div></div>`;
  $('aS').onclick = e => { e.preventDefault(); signup = !signup; $('aT').textContent = signup ? 'Create account' : 'Login'; $('aB').textContent = signup ? 'Sign up' : 'Login'; $('nameBox').classList.toggle('hidden', !signup); $('aP').autocomplete = signup ? 'new-password' : 'current-password'; $('authHint').textContent = signup ? 'Use a unique password with at least 8 characters.' : 'Sign in to report campus problems and track their progress.'; };
  $('aB').onclick = async () => {
    try {
      const d = await api(signup ? '/api/signup' : '/api/login', { method: 'POST', body: { name: $('aN').value, email: $('aE').value, password: $('aP').value } });
      token = d.token; user = d.user;
      const tokenSaved = sessionStore.set('token', token);
      const userSaved = sessionStore.set('user', JSON.stringify(user));
      boot();
      if (!tokenSaved || !userSaved) toast('Browser storage is blocked. CampusFix can work in this tab, but refreshing will sign you out.', 1);
    } catch (e) { handle(e); }
  };
}

const NAV = {
  student: [['#/', 'Dashboard'], ['#/report', 'Report issue'], ['#/issues?mine=1', 'My issues'], ['#/issues', 'All issues'], ['#/map', 'Campus map'], ['#/notifications', 'Notifications']],
  staff: [['#/', 'Dashboard'], ['#/issues?dept=mine', 'Department issues'], ['#/issues?assigned=me', 'Assigned to me'], ['#/issues', 'All issues'], ['#/map', 'Campus map'], ['#/notifications', 'Notifications']],
  admin: [['#/', 'Dashboard'], ['#/issues', 'All issues'], ['#/issues?overdue=1', 'Overdue'], ['#/map', 'Campus map'], ['#/users', 'Users'], ['#/manage', 'Manage'], ['#/notifications', 'Notifications']]
};

async function boot() {
  if (!user) return landing();
  try { meta = await api('/api/meta'); } catch (e) { return handle(e); }
  $('app').innerHTML = `<div class="layout"><aside class="side" id="side">
    <div class="row between"><div class="brand">CampusFix</div><button class="menuBtn" aria-label="Toggle menu" onclick="$('side').classList.toggle('open')">☰</button></div>
    <nav id="nav">${NAV[user.role].map(([h, l]) => `<a href="${h}">${l}${l === 'Notifications' ? ' <span id="nb" class="badge Reopened hidden"></span>' : ''}</a>`).join('')}</nav>
    <div class="me">${esc(user.name)} (${user.role})<br><a href="#" onclick="logout();return false" style="color:#9db4ff">Logout</a></div></aside>
    <main class="content" id="view"></main></div>`;
  refreshUnread(); route();
}
async function refreshUnread() {
  try { const n = (await api('/api/notifications')).unread, b = $('nb'); if (b) { b.textContent = n; b.classList.toggle('hidden', !n); } } catch { }
}
window.onhashchange = route;

async function route() {
  if (!user || !$('view')) return;
  const h = location.hash || '#/', [p, qs] = h.slice(1).split('?');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === h));
  $('side').classList.remove('open');
  $('view').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    if (p === '/') await pDash();
    else if (p === '/report') await pReport();
    else if (p === '/issues') await pIssues(qs || '');
    else if (p.startsWith('/issue/')) await pIssue(p.split('/')[2]);
    else if (p === '/map') await pMap();
    else if (p === '/notifications') await pNotif();
    else if (p === '/users' && user.role === 'admin') await pUsers();
    else if (p === '/manage' && user.role === 'admin') await pManage();
    else $('view').innerHTML = '<div class="card">Page not found.</div>';
  } catch (e) { $('view').innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}

// ---------- shared pieces ----------
const stat = (n, l) => `<div class="stat"><b>${n ?? '—'}</b>${l}</div>`;
function bars(title, rows) {
  const max = Math.max(1, ...rows.map(r => r.n));
  return `<div class="card"><h3>${title}</h3>${rows.length ? rows.map(r => `<div class="bar"><span class="l" title="${esc(r.label)}">${esc(r.label)}</span><i style="width:${r.n / max * 55}%"></i> ${r.n}</div>`).join('') : '<p class="muted">No data yet.</p>'}</div>`;
}
const issueCard = i => `<div class="card issue"><div class="row between"><a class="title" href="#/issue/${i.id}">${esc(i.title)}</a>
  <div>${badge(i.priority, 'p-')} ${badge(i.status)}${i.overdue ? ' <span class="badge overdue">Overdue</span>' : ''}</div></div>
  <div class="muted">${esc(i.code)} · ${esc(i.category)} · ${esc(i.location)} · ${esc(i.reporter)} · ${fmt(i.created_at)}</div>
  <p>${esc(i.description.slice(0, 160))}${i.description.length > 160 ? '…' : ''}</p>
  <button class="ghost ${i.voted ? 'on' : ''}" aria-label="Upvote" onclick="vote(${i.id},this)">▲ ${i.votes}</button></div>`;
async function vote(id, btn) {
  try { const r = await api(`/api/issues/${id}/vote`, { method: 'POST' }); btn.textContent = '▲ ' + r.votes; btn.classList.toggle('on', r.voted); } catch (e) { handle(e); }
}
const opts = (arr, label = 'name') => arr.map(x => `<option value="${x.id}">${esc(x[label])}</option>`).join('');

// ---------- dashboard ----------
async function pDash() {
  const d = await api('/api/dashboard');
  let h = `<h2>Welcome, ${esc(user.name)}</h2>`;
  if (d.role === 'student') {
    h += `<p><button onclick="location.hash='#/report'">Report a new issue</button></p><div class="grid">${stat(d.total, 'Total reported')}${stat(d.inProgress, 'In progress')}${stat(d.awaiting, 'Awaiting your confirmation')}${stat(d.resolved, 'Resolved')}${stat(d.reopened, 'Reopened')}</div>
      <h3>Recently updated</h3>${d.recent.map(issueCard).join('') || '<div class="card muted">You have not reported anything yet.</div>'}`;
  } else if (d.role === 'staff') {
    h += `<div class="grid">${stat(d.newIssues, 'New / in review')}${stat(d.active, 'Active')}${stat(d.urgent, 'Critical + High')}${stat(d.dueSoon, 'Due in 24h')}${stat(d.overdue, 'Overdue')}${stat(d.resolved, 'Resolved')}</div>${bars('Open workload by staff member', d.workload)}`;
  } else {
    h += `<div class="grid">${stat(d.total, 'Total issues')}${stat(d.open, 'Open')}${stat(d.inProgress, 'In progress')}${stat(d.resolved, 'Resolved')}${stat(d.overdue, 'Overdue')}
      ${stat(d.avgResolutionHours == null ? '—' : d.avgResolutionHours + ' h', 'Avg resolution time')}${stat(d.resolutionRate + '%', 'Resolution rate')}${stat(d.avgRating ? d.avgRating.toFixed(1) + ' / 5' : '—', 'Avg rating')}</div>
      ${bars('Issues by category', d.byCategory)}${bars('Issues by building', d.byLocation)}${bars('Issues by department', d.byDepartment)}${bars('Submissions, last 30 days', d.trend)}`;
  }
  $('view').innerHTML = h;
}

// ---------- directory ----------
async function pIssues(qs) {
  const base = new URLSearchParams(qs);
  const title = base.get('mine') ? 'My issues' : base.get('dept') ? 'Department issues' : base.get('assigned') ? 'Assigned to me' : base.get('overdue') ? 'Overdue issues' : 'All issues';
  $('view').innerHTML = `<h2>${title}</h2><div class="filters">
    <input id="fq" placeholder="Search title, description or ID" aria-label="Search">
    <select id="fs" aria-label="Status"><option value="">All statuses</option>${meta.statuses.map(s => `<option>${s}</option>`).join('')}</select>
    <select id="fc" aria-label="Category"><option value="">All categories</option>${opts(meta.categories)}</select>
    <select id="fl" aria-label="Location"><option value="">All locations</option>${opts(meta.locations)}</select>
    <select id="fp" aria-label="Priority"><option value="">All priorities</option>${meta.priorities.map(s => `<option>${s}</option>`).join('')}</select>
    <select id="fo" aria-label="Sort"><option value="new">Newest</option><option value="votes">Most upvoted</option></select></div>
    <div id="list"></div><button class="ghost" id="more">Load more</button>`;
  let page = 1;
  const load = async reset => {
    if (reset) { page = 1; $('list').innerHTML = ''; }
    const q = new URLSearchParams(base);
    [['q', 'fq'], ['status', 'fs'], ['category', 'fc'], ['location', 'fl'], ['priority', 'fp'], ['sort', 'fo']].forEach(([k, id]) => { if ($(id).value) q.set(k, $(id).value); });
    q.set('page', page);
    const items = await api('/api/issues?' + q);
    if (reset && !items.length) $('list').innerHTML = '<div class="card muted">No issues match these filters.</div>';
    $('list').insertAdjacentHTML('beforeend', items.map(issueCard).join(''));
    $('more').style.display = items.length < 20 ? 'none' : 'block'; page++;
  };
  ['fs', 'fc', 'fl', 'fp', 'fo'].forEach(id => $(id).onchange = () => load(true).catch(handle));
  let t; $('fq').oninput = () => { clearTimeout(t); t = setTimeout(() => load(true).catch(handle), 300); };
  $('more').onclick = () => load(false).catch(handle);
  await load(true);
}

// ---------- report ----------
async function pReport() {
  if (user.role !== 'student') { $('view').innerHTML = '<div class="card">Only students can report issues.</div>'; return; }
  $('view').innerHTML = `<h2>Report an issue</h2><div class="card">
    <label for="t">Title <span aria-hidden="true">*</span></label><input id="t" maxlength="120" required placeholder="e.g. Wi-Fi not working in Lab 3">
    <label for="d">Description <span aria-hidden="true">*</span></label><textarea id="d" maxlength="2000" required placeholder="Describe what happened and where it is affecting people."></textarea>
    <div id="sg"></div>
    <label for="c">Category <span aria-hidden="true">*</span></label><select id="c" required><option value="">Select category</option>${opts(meta.categories)}</select>
    <label for="l">Campus location <span aria-hidden="true">*</span></label><select id="l" required><option value="">Select location</option>${opts(meta.locations)}</select>
    <label for="r">Room / floor (optional)</label><input id="r" maxlength="60" placeholder="e.g. Block B, Room 204">
    <p id="pinHint" class="muted">Optional: click the map to mark the exact spot. The map opens near Marwadi University.</p><div id="pickMap"></div>
    <label for="ph">Photo (optional, JPG/PNG/WebP, max 5 MB)</label><input id="ph" type="file" accept="image/jpeg,image/png,image/webp">
    <img id="photoPreview" class="photo-preview hidden" alt="Preview of the selected issue photo">
    <label class="inline"><input type="checkbox" id="an"> Report anonymously (your name is hidden from other students and staff)</label>
    <button id="go">Submit report</button></div>`;
  let lat = null, lng = null, marker = null, previewUrl = null;
  const map = L.map('pickMap').setView(CENTER, 16); L.tileLayer(TILES, { attribution: '© OpenStreetMap' }).addTo(map);
  map.on('click', e => {
    lat = e.latlng.lat; lng = e.latlng.lng;
    marker ? marker.setLatLng(e.latlng) : marker = L.marker(e.latlng).addTo(map);
    $('pinHint').textContent = `Exact pin selected: ${lat.toFixed(6)}, ${lng.toFixed(6)}. Click the map again to move it.`;
  });
  $('ph').onchange = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    const file = $('ph').files[0], preview = $('photoPreview');
    if (!file) { preview.classList.add('hidden'); preview.removeAttribute('src'); return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      $('ph').value = ''; preview.classList.add('hidden'); preview.removeAttribute('src');
      toast('Choose a JPG, PNG, or WebP image no larger than 5 MB.', 1); return;
    }
    previewUrl = URL.createObjectURL(file); preview.src = previewUrl; preview.classList.remove('hidden');
  };

  let timer;
  const check = () => { clearTimeout(timer); timer = setTimeout(async () => {
    if ($('d').value.trim().length < 10) return;
    try {
      const r = await api('/api/suggest', { method: 'POST', body: { title: $('t').value, description: $('d').value } }), s = r.suggestion;
      if (!$('c').value && s.category_id) $('c').value = s.category_id;
      $('sg').innerHTML = `<div class="card suggest"><b>Suggestion</b> <span class="muted">(automatic ${esc(s.method)} guess, not verified)</span>
        <p>Category: <b>${esc(s.category)}</b> · Department: <b>${esc(s.department || '—')}</b> · Priority: ${badge(s.priority, 'p-')}</p><p class="muted">${esc(s.reason)}</p></div>` +
        (r.duplicates.length ? `<div class="card"><b>Similar open reports</b><p class="muted">If it is the same problem, upvote that report. You can still submit your own.</p>${r.duplicates.map(x =>
          `<div class="row between"><a href="#/issue/${x.id}">${esc(x.code)} · ${esc(x.title)}</a><span>${badge(x.status)} ▲ ${x.votes} · ${x.score}% match</span></div>`).join('')}</div>` : '');
    } catch { }
  }, 600); };
  $('t').oninput = check; $('d').oninput = check;

  $('go').onclick = async () => {
    if ($('t').value.trim().length < 5 || $('t').value.trim().length > 120) return toast('Title must be 5-120 characters.', 1);
    if ($('d').value.trim().length < 10 || $('d').value.trim().length > 2000) return toast('Description must be 10-2000 characters.', 1);
    if (!$('c').value) return toast('Please choose an issue category.', 1);
    if (!$('l').value) return toast('Please choose a campus location.', 1);
    const fd = new FormData();
    fd.append('title', $('t').value); fd.append('description', $('d').value); fd.append('category_id', $('c').value);
    fd.append('location_id', $('l').value); fd.append('room', $('r').value); fd.append('anonymous', $('an').checked ? '1' : '0');
    if (lat !== null) { fd.append('lat', lat); fd.append('lng', lng); }
    if ($('ph').files[0]) fd.append('photo', $('ph').files[0]);
    $('go').disabled = true;
    try { const r = await api('/api/issues', { method: 'POST', body: fd }); toast(`Submitted as ${r.code}`); location.hash = '#/issue/' + r.id; }
    catch (e) { handle(e); $('go').disabled = false; }
  };
}

// ---------- map ----------
async function pMap() {
  $('view').innerHTML = `<h2>Campus map</h2><div class="filters"><select id="ms" aria-label="Status"><option value="">All statuses</option>${meta.statuses.map(s => `<option>${s}</option>`).join('')}</select>
    <span class="muted">Marker colour = priority. Anonymous reports show only at building level.</span></div><div id="bigMap"></div><p id="mapEmpty" class="muted" hidden>No issue pins are available yet. Add a map pin while reporting an issue, or configure verified building coordinates under Admin → Manage.</p>`;
  const map = L.map('bigMap').setView(CENTER, 16); L.tileLayer(TILES, { attribution: '© OpenStreetMap' }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  const load = async () => {
    layer.clearLayers();
    const items = await api('/api/issues?limit=200' + ($('ms').value ? '&status=' + encodeURIComponent($('ms').value) : ''));
    const mapped = items.filter(i => Number.isFinite(i.lat) && Number.isFinite(i.lng));
    mapped.forEach(i => L.circleMarker([i.lat, i.lng], { radius: 9, color: '#fff', weight: 2, fillColor: COLORS[i.priority], fillOpacity: .9 }).addTo(layer)
      .bindPopup(`<b>${esc(i.title)}</b><br>${esc(i.code)} · ${esc(i.status)} · ${esc(i.priority)}<br><a href="#/issue/${i.id}">Open</a>`));
    $('mapEmpty').hidden = mapped.length > 0;
  };
  $('ms').onchange = () => load().catch(handle); await load();
}

// ---------- issue detail ----------
const LABEL = { 'Under Review': 'Start review', 'In Progress': 'Start work', 'Awaiting Student Confirmation': 'Mark fixed (ask student to confirm)', 'Resolved': 'Confirm resolved', 'Rejected': 'Reject', 'Reopened': 'Reopen: problem remains' };
async function pIssue(id) {
  const i = await api('/api/issues/' + id);
  const manage = user.role === 'admin' || (user.role === 'staff' && user.department_id === i.department_id);
  const next = (meta.transitions[i.status] || []).filter(s => s !== 'Assigned' && (user.role === 'student' ? i.mine && ['Resolved', 'Reopened'].includes(s) : user.role === 'staff' ? manage && s !== 'Resolved' : true));
  const open = !['Resolved', 'Rejected'].includes(i.status);
  const staff = user.role === 'admin' && open ? (await api('/api/users')).filter(u => u.role === 'staff') : [];
  $('view').innerHTML = `<p><a href="#/issues">← Back to issues</a></p>
  <div class="card detail"><div class="row between"><h2>${esc(i.title)}</h2><div>${badge(i.priority, 'p-')} ${badge(i.status)}${i.overdue ? ' <span class="badge overdue">Overdue</span>' : ''}</div></div>
    <div class="muted">${esc(i.code)} · ${esc(i.category)} · ${esc(i.department)} · ${esc(i.location)}${i.room ? ', ' + esc(i.room) : ''} · Reported by ${esc(i.reporter)} on ${fmt(i.created_at)}</div>
    <p>${esc(i.description).replace(/\n/g, '<br>')}</p>${i.photo ? '<img id="issuePhoto" alt="Photo attached to the report" loading="lazy">' : ''}
    <p class="muted">Target resolution: ${fmt(i.due_at)} · Assigned to: ${esc(i.assignee_name || 'not yet assigned')}</p>
    ${i.lat != null ? '<div id="mm" class="miniMap"></div>' : ''}
    <p><button class="ghost ${i.voted ? 'on' : ''}" aria-label="Upvote" onclick="vote(${i.id},this)">▲ ${i.votes}</button></p></div>
  ${next.length || staff.length || (manage && user.role !== 'student') ? `<div class="card"><h3>Actions</h3>
    ${next.length ? `<label for="note">Note (required for reject, fixed and reopen)</label><textarea id="note"></textarea><div class="row">${next.map(s => `<button class="${s === 'Rejected' ? 'danger' : ''}" onclick="act(${i.id},'${s}')">${LABEL[s] || s}</button>`).join('')}</div>` : ''}
    ${staff.length ? `<hr><label for="as">Assign to staff</label><div class="row"><select id="as">${staff.map(s => `<option value="${s.id}">${esc(s.name)} (${esc(meta.departments.find(d => d.id === s.department_id)?.name || '')})</option>`).join('')}</select><button onclick="assign(${i.id})">Assign</button></div>` : ''}
    ${manage && user.role !== 'student' ? `<hr><label for="pr">Priority</label><div class="row"><select id="pr">${meta.priorities.map(p => `<option ${p === i.priority ? 'selected' : ''}>${p}</option>`).join('')}</select><button class="ghost" onclick="setPri(${i.id})">Change priority</button></div>` : ''}</div>` : ''}
  ${i.mine && i.status === 'Resolved' && !i.feedback ? `<div class="card"><h3>How did we do?</h3><label for="rt">Rating</label><select id="rt"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select><label for="fc">Feedback (optional)</label><textarea id="fc"></textarea><button onclick="sendFb(${i.id})">Submit feedback</button></div>` : ''}
  ${i.feedback ? `<div class="card"><b>Feedback:</b> ${i.feedback.rating} / 5 ${i.feedback.comment ? '· ' + esc(i.feedback.comment) : ''}</div>` : ''}
  <div class="card"><h3>Activity timeline</h3><div class="timeline">${i.history.map(h => `<div><b>${esc(h.to_status)}</b> <span class="muted">${fmt(h.created_at)} · ${esc(h.by_name || 'System')}</span>${h.note ? `<br>${esc(h.note)}` : ''}</div>`).join('')}</div></div>
  <div class="card"><h3>Comments</h3>${i.comments.map(c => `<div class="comment"><b>${esc(c.name)}</b> <span class="badge">${esc(c.role)}</span> <span class="muted">${fmt(c.created_at)}</span><br>${esc(c.body)}</div>`).join('') || '<p class="muted">No comments yet.</p>'}
    <label for="cm">Add a comment</label><textarea id="cm" maxlength="1000"></textarea><button onclick="sendComment(${i.id})">Post comment</button></div>`;
  if (i.photo) {
    const photo = $('issuePhoto');
    try {
      const response = await fetch('/uploads/' + encodeURIComponent(i.photo), { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) throw new Error('Photo unavailable');
      const objectUrl = URL.createObjectURL(await response.blob());
      photo.onload = () => URL.revokeObjectURL(objectUrl);
      photo.src = objectUrl;
    } catch { photo.alt = 'The attached photo could not be loaded.'; }
  }
  if (i.lat != null) { const m = L.map('mm', { scrollWheelZoom: false }).setView([i.lat, i.lng], 17); L.tileLayer(TILES, { attribution: '© OpenStreetMap' }).addTo(m); L.marker([i.lat, i.lng]).addTo(m); }
}
const post = async (url, body, msg) => { try { await api(url, { method: 'POST', body }); toast(msg); refreshUnread(); route(); } catch (e) { handle(e); } };
const act = (id, status) => post(`/api/issues/${id}/status`, { status, note: $('note').value }, 'Status updated');
const assign = id => post(`/api/issues/${id}/assign`, { staff_id: $('as').value }, 'Assigned');
const setPri = id => post(`/api/issues/${id}/priority`, { priority: $('pr').value }, 'Priority changed');
const sendComment = id => post(`/api/issues/${id}/comments`, { body: $('cm').value }, 'Comment posted');
const sendFb = id => post(`/api/issues/${id}/feedback`, { rating: $('rt').value, comment: $('fc').value }, 'Thank you for the feedback');

// ---------- notifications ----------
async function pNotif() {
  const d = await api('/api/notifications');
  $('view').innerHTML = `<div class="row between"><h2>Notifications</h2><button class="ghost" id="mr">Mark all as read</button></div>
    ${d.items.map(n => `<div class="card" style="${n.is_read ? 'opacity:.65' : ''}">${n.issue_id ? `<a href="#/issue/${n.issue_id}">${esc(n.message)}</a>` : esc(n.message)}<div class="muted">${fmt(n.created_at)}</div></div>`).join('') || '<div class="card muted">No notifications yet.</div>'}`;
  $('mr').onclick = async () => { try { await api('/api/notifications/read', { method: 'POST' }); route(); refreshUnread(); } catch (e) { handle(e); } };
}

// ---------- admin ----------
async function pUsers() {
  const users = await api('/api/users');
  $('view').innerHTML = `<h2>Users</h2><div class="card" style="overflow-x:auto"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Department (staff)</th><th></th></tr>
    ${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
      <td><select id="r${u.id}" aria-label="Role" ${u.id === user.id ? 'disabled' : ''}>${['student', 'staff', 'admin'].map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td><select id="d${u.id}" aria-label="Department" ${u.id === user.id ? 'disabled' : ''}><option value="">—</option>${meta.departments.map(d => `<option value="${d.id}" ${d.id === u.department_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></td>
      <td>${u.id === user.id ? '' : `<button class="ghost" onclick="saveUser(${u.id})">Save</button>`}</td></tr>`).join('')}</table></div>`;
}
const saveUser = async id => { try { await api('/api/users/' + id, { method: 'PATCH', body: { role: $('r' + id).value, department_id: $('d' + id).value } }); toast('User updated'); } catch (e) { handle(e); } };

async function pManage() {
  const audit = await api('/api/audit'), sla = Object.fromEntries(meta.sla.map(s => [s.priority, s.hours]));
  $('view').innerHTML = `<h2>Manage</h2>
  <div class="card"><h3>Resolution targets (SLA, in hours)</h3><div class="row">${meta.priorities.map(p => `<div><label for="s${p}">${p}</label><input id="s${p}" type="number" min="1" value="${sla[p]}"></div>`).join('')}</div><button onclick="saveSla()">Save targets</button>
    <p class="muted">Overdue issues are escalated automatically to admins and the responsible staff.</p></div>
  <div class="card"><h3>Add department</h3><input id="nd" placeholder="Name" aria-label="Department name"><button onclick="addItem('departments',{name:$('nd').value})">Add</button></div>
  <div class="card"><h3>Add category</h3><input id="nc" placeholder="Name" aria-label="Category name"><select id="ncd" aria-label="Department">${opts(meta.departments)}</select><button onclick="addItem('categories',{name:$('nc').value,department_id:$('ncd').value})">Add</button></div>
  <div class="card"><h3>Add campus location</h3><input id="nl" placeholder="Building name" aria-label="Building name"><div class="row"><input id="nla" type="number" step="any" min="-90" max="90" placeholder="Latitude (optional)" aria-label="Latitude"><input id="nlg" type="number" step="any" min="-180" max="180" placeholder="Longitude (optional)" aria-label="Longitude"></div><button onclick="addItem('locations',{name:$('nl').value,lat:$('nla').value,lng:$('nlg').value})">Add</button><p class="muted">Only enter verified coordinates. Leave both blank until you have checked the location on a map.</p></div>
  <div class="card" style="overflow-x:auto"><h3>Configure existing map locations</h3><p class="muted">Set precise coordinates for your campus buildings. These pins are used when an issue has no exact map pin.</p><table><tr><th>Location</th><th>Latitude</th><th>Longitude</th><th></th></tr>
    ${meta.locations.map(l => `<tr><td>${esc(l.name)}</td><td><input type="number" step="any" min="-90" max="90" id="llat${l.id}" value="${l.lat ?? ''}" aria-label="${esc(l.name)} latitude"></td><td><input type="number" step="any" min="-180" max="180" id="llng${l.id}" value="${l.lng ?? ''}" aria-label="${esc(l.name)} longitude"></td><td><button class="ghost" onclick="saveLocation(${l.id})">Save</button></td></tr>`).join('')}</table></div>
  <div class="card"><h3>Reports</h3><button onclick="exportCsv()">Download all issues (CSV)</button> <span class="muted">Reporter identities are not included.</span></div>
  <div class="card" style="overflow-x:auto"><h3>Audit log (latest 50)</h3><table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>
    ${audit.map(a => `<tr><td>${fmt(a.created_at)}</td><td>${esc(a.user_name || 'System')}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>'}</table></div>`;
}
const saveSla = async () => { try { const b = {}; meta.priorities.forEach(p => b[p] = $('s' + p).value); await api('/api/sla', { method: 'PUT', body: b }); meta = await api('/api/meta'); toast('Targets saved'); } catch (e) { handle(e); } };
const addItem = async (kind, body) => { try { await api('/api/' + kind, { method: 'POST', body }); meta = await api('/api/meta'); toast('Added'); pManage(); } catch (e) { handle(e); } };
const saveLocation = async id => { try { await api('/api/locations/' + id, { method: 'PATCH', body: { lat: $('llat' + id).value, lng: $('llng' + id).value } }); meta = await api('/api/meta'); toast('Location coordinates saved'); pManage(); } catch (e) { handle(e); } };
async function exportCsv() {
  try { const t = await api('/api/export.csv'), a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = 'issues.csv'; a.click(); } catch (e) { handle(e); }
}

boot();
