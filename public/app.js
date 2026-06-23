const $ = id => document.getElementById(id);

const api = async (url, opts = {}) => {
  const headers = opts.body instanceof FormData ? {} : {'Content-Type': 'application/json'};
  const r = await fetch(url, {...opts, headers: {...headers, ...(opts.headers || {})}});
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || 'Request failed' }; }
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
};

const employeeFields = ['first_name','last_name','title','email','location','manager_id','team_id','start_date','level','status','skills','bio'];
const configs = {
  teams: ['name','description'],
  employees: employeeFields,
  projects: ['name','description','owner_employee_id','team_id','status','start_date','end_date'],
  tasks: ['project_id','assigned_employee_id','title','description','status','priority','due_date'],
  achievements: ['employee_id','title','description','achievement_date','category'],
  career_progression: ['employee_id','from_role','to_role','progression_date','notes'],
  action_plans: ['employee_id','title','objective','owner','due_date','status'],
  development_plans: ['employee_id','skill_area','development_goal','learning_actions','target_date','status']
};
const requiredFields = {
  teams: ['name'], employees: ['first_name','last_name','email'], projects: ['name'], tasks: ['title'], achievements: ['employee_id','title'], career_progression: ['employee_id'], action_plans: ['employee_id','title'], development_plans: ['employee_id','skill_area']
};
const labels = s => s.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
let currentUser = null, employees = [], teams = [], projects = [];

async function boot(){
  try {
    const me = await api('/api/me'); currentUser = me.user;
    $('login').classList.toggle('hidden', !!currentUser); $('app').classList.toggle('hidden', !currentUser);
    if(currentUser){ await refreshLookups(); show('dashboard'); }
  } catch(e) { alert(e.message); }
}
async function login(){ try{ await api('/api/login',{method:'POST',body:JSON.stringify({email:$('email').value,password:$('password').value})}); boot(); }catch(e){alert(e.message)} }
async function logout(){ await api('/api/logout',{method:'POST'}); location.reload(); }
function show(id){ document.querySelectorAll('.page').forEach(p=>p.classList.add('hidden')); $(id).classList.remove('hidden'); if(id==='dashboard') loadDashboard(); if(id==='directory') loadDirectory(); if(id==='org') loadOrg(); const map={teams:'teams',employees:'employees',projects:'projects',tasks:'tasks',achievements:'achievements',progression:'career_progression',actions:'action_plans',development:'development_plans'}; if(map[id]) loadTable(map[id]); }
async function refreshLookups(){ teams = await api('/api/teams'); employees = await api('/api/employees'); projects = await api('/api/projects'); }
async function loadDashboard(){ const d = await api('/api/dashboard'); $('metrics').innerHTML = Object.entries(d).map(([k,v])=>`<div class="card"><div class="metric">${v}</div><div>${labels(k)}</div></div>`).join(''); }

function inputFor(field, table){
  const req = (requiredFields[table] || []).includes(field) ? 'required' : '';
  if(field==='team_id') return `<select name="team_id"><option value="">No team</option>${teams.map(t=>`<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select>`;
  if(field==='manager_id'||field==='employee_id'||field==='owner_employee_id'||field==='assigned_employee_id') return `<select name="${field}" ${req}><option value="">Select employee</option>${employees.map(e=>`<option value="${e.id}">${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}</option>`).join('')}</select>`;
  if(field==='project_id') return `<select name="project_id"><option value="">No project</option>${projects.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>`;
  if(field==='status') return `<select name="status"><option>Active</option><option>Planning</option><option>Open</option><option>In progress</option><option>Blocked</option><option>Done</option><option>Archived</option></select>`;
  if(field==='priority') return `<select name="priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Critical</option></select>`;
  if(field.includes('date')) return `<input name="${field}" type="date" placeholder="${labels(field)}"/>`;
  if(['description','bio','objective','notes','learning_actions','development_goal'].includes(field)) return `<textarea name="${field}" placeholder="${labels(field)}" ${req}></textarea>`;
  return `<input name="${field}" placeholder="${labels(field)}" ${req}/>`;
}
async function loadTable(table){
  await refreshLookups();
  const rows = await api(`/api/${table}`);
  const formId = `${table}Form`;
  $(formId).innerHTML = `<form class="form" onsubmit="createRow(event,'${table}')">${configs[table].map(f=>inputFor(f, table)).join('')}<button>Add ${labels(table)}</button></form>`;
  const th = ['id', ...configs[table]];
  $(`${table}Table`).innerHTML = `<thead><tr>${th.map(h=>`<th>${labels(h)}</th>`).join('')}<th>Actions</th></tr></thead><tbody>${rows.map(r=>`<tr>${th.map(h=>`<td>${displayValue(h, r[h])}</td>`).join('')}<td><button onclick="deleteRow('${table}',${r.id})">Delete</button></td></tr>`).join('')}</tbody>`;
}
function displayValue(field, value){
  if(value === null || value === undefined) return '';
  if(['employee_id','manager_id','owner_employee_id','assigned_employee_id'].includes(field)) { const e = employees.find(x=>String(x.id)===String(value)); return e ? `${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}` : value; }
  if(field==='team_id') { const t = teams.find(x=>String(x.id)===String(value)); return t ? escapeHtml(t.name) : value; }
  if(field==='project_id') { const p = projects.find(x=>String(x.id)===String(value)); return p ? escapeHtml(p.name) : value; }
  return escapeHtml(String(value));
}
async function createRow(e, table){ e.preventDefault(); try { const data = Object.fromEntries(new FormData(e.target).entries()); Object.keys(data).forEach(k=>{if(data[k]==='') delete data[k]}); await api(`/api/${table}`, {method:'POST', body:JSON.stringify(data)}); e.target.reset(); await loadTable(table); } catch(err) { alert(err.message); } }
async function deleteRow(table,id){ if(confirm('Delete this record?')){ try{ await api(`/api/${table}/${id}`,{method:'DELETE'}); await loadTable(table); }catch(e){ alert(e.message); } } }

async function importEmployees(){
  const file = $('employeeImportFile').files[0];
  if(!file) return alert('Choose an Excel or CSV file first.');
  const fd = new FormData(); fd.append('file', file);
  try {
    const result = await api('/api/import/employees', { method:'POST', body: fd });
    $('importResult').textContent = `Created: ${result.created}\nUpdated: ${result.updated}\nSkipped: ${result.skipped}\n${(result.errors || []).join('\n')}`;
    await refreshLookups(); await loadTable('employees');
  } catch(e) { alert(e.message); }
}
async function loadDirectory(){ const q = encodeURIComponent($('search')?.value || ''); const rows = await api(`/api/people-directory?q=${q}`); $('directoryRows').innerHTML = rows.map(e=>`<div class="person-card"><h3>${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}</h3><p>${escapeHtml(e.title||'')}<br><span class="muted">${escapeHtml(e.team_name||'No team')} · ${escapeHtml(e.location||'')}</span></p><p>${(e.skills||'').split(',').filter(Boolean).map(s=>`<span class="tag">${escapeHtml(s.trim())}</span>`).join('')}</p><button onclick="talentMemo(${e.id})">Generate talent memo</button><pre id="memo-${e.id}"></pre></div>`).join(''); }
async function talentMemo(id){ const r = await api(`/api/ai/talent-memo/${id}`,{method:'POST'}); $(`memo-${id}`).textContent = r.memo; }
async function loadOrg(){ const rows = await api('/api/org-chart'); const byManager = {}; rows.forEach(r => { const key = r.manager_id || 'root'; (byManager[key] ||= []).push(r); }); const render = parent => `<ul>${(byManager[parent]||[]).map(e=>`<li><strong>${escapeHtml(e.name)}</strong><br><span class="muted">${escapeHtml(e.title||'')} · ${escapeHtml(e.team||'')}</span>${render(e.id)}</li>`).join('')}</ul>`; $('orgChart').innerHTML = render('root'); }
function escapeHtml(s){ return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
boot();
