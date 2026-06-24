const $ = id => document.getElementById(id);

const api = async (url, opts = {}) => {
  const headers = opts.body instanceof FormData ? {} : {'Content-Type': 'application/json'};
  if (!['GET', 'HEAD'].includes((opts.method || 'GET').toUpperCase()) && currentUser?.csrfToken) headers['X-CSRF-Token'] = currentUser.csrfToken;
  const r = await fetch(url, {...opts, headers: {...headers, ...(opts.headers || {})}});
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || 'Request failed' }; }
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
};

const employeeFields = ['first_name','last_name','title','email','location','manager_id','team_id','start_date','level','status','skills','bio','photo_url'];
const configs = {
  teams: ['name','description'], employees: employeeFields,
  projects: ['name','description','owner_employee_id','team_id','status','start_date','end_date'],
  tasks: ['project_id','assigned_employee_id','title','description','status','priority','due_date'],
  achievements: ['employee_id','title','description','achievement_date','category'],
  career_progression: ['employee_id','from_role','to_role','progression_date','notes'],
  action_plans: ['employee_id','title','objective','owner','due_date','status'],
  development_plans: ['employee_id','skill_area','development_goal','learning_actions','target_date','status'],
  users: ['name','email','role','employee_id','password']
};
const requiredFields = { teams:['name'], employees:['first_name','last_name','email'], projects:['name'], tasks:['title'], achievements:['employee_id','title'], career_progression:['employee_id'], action_plans:['employee_id','title'], development_plans:['employee_id','skill_area'], users:['name','email','role'] };
const defaultTabs = { dashboard:'Dashboard', directory:'People Directory', teams:'Teams', employees:'Employees', projects:'Projects', tasks:'Tasks', achievements:'Achievements', progression:'Career Progression', actions:'Talent Action Plan', development:'Talent Development', org:'Org Chart', hr:'HR Secure Info', settings:'Settings', users:'Users' };
const navPages = ['dashboard','directory','teams','employees','projects','tasks','achievements','progression','actions','development','org','hr','settings','users'];
const labels = s => s.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
let currentUser = null, settings = {tabs: defaultTabs, theme: {}}, employees = [], teams = [], projects = [], activePage = 'dashboard', editing = null;

async function boot(){
  const me = await api('/api/me'); currentUser = me.user;
  $('login').classList.toggle('hidden', !!currentUser); $('app').classList.toggle('hidden', !currentUser);
  if(currentUser){ settings = {...settings, ...(await api('/api/settings'))}; applyTheme(); renderNav(); await refreshLookups(); show('dashboard'); }
}
function roles(){ return currentUser?.roles || (currentUser?.role ? String(currentUser.role).split(',') : ['user']); }
function role(){ return currentUser?.role || roles()[0] || 'user'; }
function hasRole(name){ return roles().includes(name); }
function isAdmin(){ return hasRole('admin'); }
function isHr(){ return hasRole('hr') || isAdmin(); }
function isManager(){ return hasRole('manager'); }
function allowedPages(){ return navPages.filter(p => isAdmin() || isHr() || !['settings','users','teams','projects','hr'].includes(p)); }
function canCreate(table){ return isAdmin() || isHr() || (isManager() && ['tasks','action_plans','development_plans','achievements'].includes(table)); }
function canEdit(table){ return isAdmin() || isHr() || (hasRole('user') && ['tasks','employees'].includes(table)) || (isManager() && ['tasks','action_plans','development_plans','achievements'].includes(table)); }
function canDelete(){ return isAdmin(); }
function tabName(id){ return settings.tabs?.[id] || defaultTabs[id] || labels(id); }
function applyTheme(){ Object.entries(settings.theme || {}).forEach(([k,v]) => document.documentElement.style.setProperty(`--${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}`, v)); }
function renderNav(){ $('navMenu').innerHTML = allowedPages().map(id => `<button onclick="show('${id}')">${escapeHtml(tabName(id))}</button>`).join('') + '<button onclick="logout()" class="secondary">Logout</button>'; }
function toggleMenu(){ const sidebar = $('sidebar'); const expanded = sidebar.classList.toggle('sidebar-collapsed') === false; $('menuToggle').setAttribute('aria-expanded', String(expanded)); }
function setActiveNav(id){ activePage = id; document.querySelectorAll('.nav-menu button').forEach(button => button.classList.toggle('active', button.getAttribute('onclick') === `show('${id}')`)); }
async function login(){ try{ await api('/api/login',{method:'POST',body:JSON.stringify({email:$('email').value,password:$('password').value})}); boot(); }catch(e){alert(e.message)} }
async function logout(){ await api('/api/logout',{method:'POST'}); location.reload(); }
function show(id){
  if(!allowedPages().includes(id)) id='dashboard';
  document.querySelectorAll('.page').forEach(p=>p.classList.add('hidden')); $(id).classList.remove('hidden'); setActiveNav(id);
  document.querySelector(`#${id} h1`).textContent = tabName(id);
  if(window.matchMedia('(max-width: 900px)').matches) { $('sidebar').classList.add('sidebar-collapsed'); $('menuToggle').setAttribute('aria-expanded', 'false'); }
  if(id==='dashboard') loadDashboard(); if(id==='directory') loadDirectory(); if(id==='org') loadOrg(); if(id==='hr') loadHrInfo(); if(id==='settings') renderSettings(); if(id==='users') loadTable('users');
  const map={teams:'teams',employees:'employees',projects:'projects',tasks:'tasks',achievements:'achievements',progression:'career_progression',actions:'action_plans',development:'development_plans'}; if(map[id]) loadTable(map[id]);
}
async function refreshLookups(){ teams = await api('/api/teams'); employees = await api('/api/employees'); projects = await api('/api/projects'); }
async function loadDashboard(){ const d = await api('/api/dashboard'); const selected = settings.dashboardCards || Object.keys(d); $('metrics').innerHTML = Object.entries(d).filter(([k])=>selected.includes(k)).map(([k,v])=>`<div class="card"><div class="metric">${v}</div><div>${labels(k)}</div></div>`).join(''); }
function selectedAttr(optionValue, value){ return String(optionValue) === String(value) ? 'selected' : ''; }
function inputFor(field, table, value = ''){
  const req = (requiredFields[table] || []).includes(field) ? 'required' : ''; const safeValue = escapeHtml(value ?? '');
  if(field==='role') { const selected = String(value || 'user').split(','); return `<fieldset class="role-picker"><legend>Access roles</legend>${['user','manager','hr','admin'].map(o=>`<label class="check-row"><input type="checkbox" name="roles" value="${o}" ${selected.includes(o) ? 'checked' : ''}> ${labels(o)}</label>`).join('')}</fieldset>`; }
  if(field==='team_id') return `<select name="team_id"><option value="">No team</option>${teams.map(t=>`<option value="${t.id}" ${selectedAttr(t.id, value)}>${escapeHtml(t.name)}</option>`).join('')}</select>`;
  if(field==='manager_id'||field==='employee_id'||field==='owner_employee_id'||field==='assigned_employee_id') return `<select name="${field}" ${req}><option value="">Select employee</option>${employees.map(e=>`<option value="${e.id}" ${selectedAttr(e.id, value)}>${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}</option>`).join('')}</select>`;
  if(field==='project_id') return `<select name="project_id"><option value="">No project</option>${projects.map(p=>`<option value="${p.id}" ${selectedAttr(p.id, value)}>${escapeHtml(p.name)}</option>`).join('')}</select>`;
  if(field==='status') { const options = ['Active','Planning','Open','In progress','Blocked','Done','Archived']; return `<select name="status">${options.map(o=>`<option ${selectedAttr(o, value)}>${o}</option>`).join('')}</select>`; }
  if(field==='priority') { const options = ['Low','Medium','High','Critical']; const selected = value || 'Medium'; return `<select name="priority">${options.map(o=>`<option ${selectedAttr(o, selected)}>${o}</option>`).join('')}</select>`; }
  if(field==='password') return `<input name="password" type="password" placeholder="${value ? 'Leave blank to keep password' : 'Password'}" ${value ? '' : req}/>`;
  if(field==='photo_url') return `<input name="photo_url" type="url" value="${safeValue}" placeholder="Profile photo URL"/>`;
  if(field.includes('date')) return `<input name="${field}" type="date" value="${safeValue}" placeholder="${labels(field)}"/>`;
  if(['description','bio','objective','notes','learning_actions','development_goal'].includes(field)) return `<textarea name="${field}" placeholder="${labels(field)}" ${req}>${safeValue}</textarea>`;
  return `<input name="${field}" value="${safeValue}" placeholder="${labels(field)}" ${req}/>`;
}
async function loadTable(table){
  await refreshLookups(); const rows = await api(`/api/${table}`); renderForm(table);
  const th = ['id', ...configs[table].filter(f => !(table==='users' && f==='password'))];
  $(`${table}Table`).innerHTML = `<thead><tr>${th.map(h=>`<th>${labels(h)}</th>`).join('')}<th>Actions</th></tr></thead><tbody>${rows.map(r=>`<tr class="${editing?.table === table && editing?.row.id === r.id ? 'editing-row' : ''}">${th.map(h=>`<td>${displayValue(h, r[h])}</td>`).join('')}<td class="actions-cell">${canEdit(table) ? `<button class="ghost" onclick="startEdit('${table}','${encodeURIComponent(JSON.stringify(r))}')">Edit</button>` : ''}${canDelete() ? `<button class="danger" onclick="deleteRow('${table}',${r.id})">Delete</button>` : ''}</td></tr>`).join('')}</tbody>`;
}
function renderForm(table, row = null){
  const formId = `${table}Form`; if(!canCreate(table) && !row){ $(formId).innerHTML = '<p class="muted">You can view this section, but your role cannot add new records here.</p>'; return; }
  const isEditing = !!row; editing = row ? { table, row } : null;
  $(formId).innerHTML = `<form class="form" onsubmit="${isEditing ? `updateRow(event,'${table}',${row.id})` : `createRow(event,'${table}')`}"><h3 class="form-title">${isEditing ? `Edit ${labels(table)} #${row.id}` : `Add ${labels(table)}`}</h3>${configs[table].map(f=>inputFor(f, table, row?.[f] ?? '')).join('')}<button>${isEditing ? 'Save changes' : `Add ${labels(table)}`}</button>${isEditing ? `<button class="ghost" type="button" onclick="cancelEdit('${table}')">Cancel</button>` : ''}</form>`;
}
function startEdit(table, encodedRow){ renderForm(table, JSON.parse(decodeURIComponent(encodedRow))); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function cancelEdit(table){ editing = null; renderForm(table); loadTable(table); }
function displayValue(field, value){ if(value == null) return ''; if(['employee_id','manager_id','owner_employee_id','assigned_employee_id'].includes(field)) { const e = employees.find(x=>String(x.id)===String(value)); return e ? `${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}` : value; } if(field==='team_id') { const t = teams.find(x=>String(x.id)===String(value)); return t ? escapeHtml(t.name) : value; } if(field==='project_id') { const p = projects.find(x=>String(x.id)===String(value)); return p ? escapeHtml(p.name) : value; } return escapeHtml(String(value)); }
function formData(form){ const fd = new FormData(form); const data = Object.fromEntries(fd.entries()); if (fd.getAll('roles').length) data.roles = fd.getAll('roles'); return data; }
function formDataWithoutBlanks(form){ const data = formData(form); Object.keys(data).forEach(k=>{if(data[k]==='') delete data[k]}); return data; }
function formDataForUpdate(form){ const data = formData(form); Object.keys(data).forEach(k=>{if(data[k]==='') data[k] = null}); return data; }
async function createRow(e, table){ e.preventDefault(); try { await api(`/api/${table}`, {method:'POST', body:JSON.stringify(formDataWithoutBlanks(e.target))}); e.target.reset(); editing = null; await loadTable(table); } catch(err) { alert(err.message); } }
async function updateRow(e, table, id){ e.preventDefault(); try { await api(`/api/${table}/${id}`, {method:'PUT', body:JSON.stringify(formDataForUpdate(e.target))}); editing = null; await loadTable(table); } catch(err) { alert(err.message); } }
async function deleteRow(table,id){ if(confirm('Delete this record?')){ try{ await api(`/api/${table}/${id}`,{method:'DELETE'}); await loadTable(table); }catch(e){ alert(e.message); } } }
function renderSettings(){
  const theme = settings.theme || {}; const tabs = {...defaultTabs, ...(settings.tabs || {})};
  const selectedCards = settings.dashboardCards || ['employees','teams','openActions','developmentPlans','projects','openTasks'];
  const dashboardOptions = ['employees','teams','openActions','developmentPlans','projects','openTasks'];
  $('settingsForm').innerHTML = `<form class="form" onsubmit="saveSettings(event)"><h3 class="form-title">Theme colors</h3>${['brand','brandDark','accent','bg','ink'].map(k=>`<label>${labels(k)}<input type="color" name="theme.${k}" value="${theme[k] || {brand:'#7c3aed',brandDark:'#5b21b6',accent:'#c084fc',bg:'#f7f2ff',ink:'#24113f'}[k]}"></label>`).join('')}<h3 class="form-title">Dashboard cards</h3>${dashboardOptions.map(k=>`<label class="check-row"><input type="checkbox" name="dashboardCards" value="${k}" ${selectedCards.includes(k) ? 'checked' : ''}> ${labels(k)}</label>`).join('')}<h3 class="form-title">Tab names</h3>${Object.keys(defaultTabs).map(k=>`<input name="tabs.${k}" value="${escapeHtml(tabs[k])}" placeholder="${escapeHtml(defaultTabs[k])}">`).join('')}<button>Save website settings</button></form>`;
}
async function saveSettings(e){ e.preventDefault(); const data = Object.fromEntries(new FormData(e.target).entries()); const theme = {}, tabs = {}; Object.entries(data).forEach(([k,v]) => { if(k.startsWith('theme.')) theme[k.slice(6)] = v; if(k.startsWith('tabs.')) tabs[k.slice(5)] = v; }); const dashboardCards = [...e.target.querySelectorAll('input[name=\"dashboardCards\"]:checked')].map(input => input.value); await api('/api/settings', {method:'PUT', body:JSON.stringify({theme,tabs,dashboardCards})}); settings = {...settings, theme, tabs, dashboardCards}; applyTheme(); renderNav(); show(activePage); alert('Website settings saved.'); }
async function importEmployees(){ const file = $('employeeImportFile').files[0]; if(!file) return alert('Choose an Excel or CSV file first.'); const fd = new FormData(); fd.append('file', file); try { const result = await api('/api/import/employees', { method:'POST', body: fd }); $('importResult').textContent = `Created: ${result.created}\nUpdated: ${result.updated}\nSkipped: ${result.skipped}\n${(result.errors || []).join('\n')}`; await refreshLookups(); await loadTable('employees'); } catch(e) { alert(e.message); } }
async function loadDirectory(){ const q = encodeURIComponent($('search')?.value || ''); const rows = await api(`/api/people-directory?q=${q}`); $('directoryRows').innerHTML = rows.map(e=>`<div class="person-card">${e.photo_url ? `<img class="avatar" src="${escapeHtml(e.photo_url)}" alt="${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}">` : ''}<h3>${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}</h3><p>${escapeHtml(e.title||'')}<br><span class="muted">${escapeHtml(e.team_name||'No team')} · ${escapeHtml(e.location||'')}</span></p><p>${(e.skills||'').split(',').filter(Boolean).map(s=>`<span class="tag">${escapeHtml(s.trim())}</span>`).join('')}</p><button onclick="talentMemo(${e.id})">Generate talent memo</button><pre id="memo-${e.id}"></pre></div>`).join(''); }

async function loadHrInfo(){
  const rows = await api('/api/hr-info');
  $('hrRows').innerHTML = rows.map(r => `<div class="card"><h3>${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)}</h3><form class="form compact-form" onsubmit="saveHrInfo(event,${r.employee_id})"><input name="salary" type="number" step="0.01" value="${escapeHtml(r.salary ?? '')}" placeholder="Salary"><input name="bonus" type="number" step="0.01" value="${escapeHtml(r.bonus ?? '')}" placeholder="Bonus"><input name="visa_status" value="${escapeHtml(r.visa_status ?? '')}" placeholder="Visa status"><input name="visa_expiry_date" type="date" value="${escapeHtml(r.visa_expiry_date ?? '')}"><input name="job_grade" value="${escapeHtml(r.job_grade ?? '')}" placeholder="Job grade"><input name="birthday" type="date" value="${escapeHtml(r.birthday ?? '')}"><input name="salary_effective_date" type="date" placeholder="Salary effective date"><input name="salary_notes" placeholder="Salary change notes"><button>Save HR info</button><button class="ghost" type="button" onclick="loadSalaryHistory(${r.employee_id})">Salary history</button></form><pre id="salary-history-${r.employee_id}"></pre></div>`).join('');
}
async function saveHrInfo(e, employeeId){ e.preventDefault(); try { await api(`/api/hr-info/${employeeId}`, {method:'PUT', body:JSON.stringify(formDataForUpdate(e.target))}); await loadHrInfo(); } catch(err) { alert(err.message); } }
async function loadSalaryHistory(employeeId){ const rows = await api(`/api/hr-info/${employeeId}/salary-history`); $(`salary-history-${employeeId}`).textContent = rows.map(r => `${r.effective_date || 'No date'}: ${r.salary} ${r.notes || ''}`).join('\n') || 'No salary history yet.'; }

async function talentMemo(id){ const r = await api(`/api/ai/talent-memo/${id}`,{method:'POST'}); $(`memo-${id}`).textContent = r.memo; }
async function loadOrg(){ const rows = await api('/api/org-chart'); const byManager = {}; rows.forEach(r => { const key = r.manager_id || 'root'; (byManager[key] ||= []).push(r); }); const render = parent => `<ul>${(byManager[parent]||[]).map(e=>`<li><strong>${escapeHtml(e.name)}</strong><br><span class="muted">${escapeHtml(e.title||'')} · ${escapeHtml(e.team||'')}</span>${render(e.id)}</li>`).join('')}</ul>`; $('orgChart').innerHTML = render('root'); }
function escapeHtml(s){ return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
boot().catch(e => alert(e.message));
