const $ = id => document.getElementById(id);
const api = async (url, opts={}) => { const r = await fetch(url, {headers:{'Content-Type':'application/json'}, ...opts}); if(!r.ok) throw new Error((await r.json()).error || 'Request failed'); return r.json(); };
const employeeFields = ['first_name','last_name','title','email','location','manager_id','team_id','start_date','level','status','skills','bio'];
const configs = {
  teams: ['name','description'],
  employees: employeeFields,
  achievements: ['employee_id','title','description','achievement_date','category'],
  career_progression: ['employee_id','from_role','to_role','progression_date','notes'],
  action_plans: ['employee_id','title','objective','owner','due_date','status'],
  development_plans: ['employee_id','skill_area','development_goal','learning_actions','target_date','status']
};
const labels = s => s.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
let currentUser=null, employees=[], teams=[];

async function boot(){ const me = await api('/api/me'); currentUser=me.user; $('login').classList.toggle('hidden', !!currentUser); $('app').classList.toggle('hidden', !currentUser); if(currentUser){ await refreshLookups(); show('dashboard'); }}
async function login(){ try{ await api('/api/login',{method:'POST',body:JSON.stringify({email:$('email').value,password:$('password').value})}); boot(); }catch(e){alert(e.message)} }
async function logout(){ await api('/api/logout',{method:'POST'}); location.reload(); }
function show(id){ document.querySelectorAll('.page').forEach(p=>p.classList.add('hidden')); $(id).classList.remove('hidden'); if(id==='dashboard') loadDashboard(); if(id==='directory') loadDirectory(); if(id==='org') loadOrg(); const map={teams:'teams',employees:'employees',achievements:'achievements',progression:'career_progression',actions:'action_plans',development:'development_plans'}; if(map[id]) loadTable(map[id]); }
async function refreshLookups(){ teams = await api('/api/teams'); employees = await api('/api/employees'); }
async function loadDashboard(){ const d = await api('/api/dashboard'); $('metrics').innerHTML = Object.entries(d).map(([k,v])=>`<div class="card"><div class="metric">${v}</div><div>${labels(k)}</div></div>`).join(''); }
function inputFor(field){
  if(field==='team_id') return `<select name="team_id"><option value="">No team</option>${teams.map(t=>`<option value="${t.id}">${t.name}</option>`).join('')}</select>`;
  if(field==='manager_id'||field==='employee_id') return `<select name="${field}"><option value="">Select employee</option>${employees.map(e=>`<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}</select>`;
  if(field==='status') return `<select name="status"><option>Active</option><option>Open</option><option>In progress</option><option>Done</option><option>Archived</option></select>`;
  if(field.includes('date')) return `<input name="${field}" type="date" placeholder="${labels(field)}"/>`;
  if(['description','bio','objective','notes','learning_actions','development_goal'].includes(field)) return `<textarea name="${field}" placeholder="${labels(field)}"></textarea>`;
  return `<input name="${field}" placeholder="${labels(field)}"/>`;
}
async function loadTable(table){ await refreshLookups(); const rows = await api(`/api/${table}`); const formId = `${table}Form`; $(formId).innerHTML = `<form class="form" onsubmit="createRow(event,'${table}')">${configs[table].map(inputFor).join('')}<button>Add ${labels(table)}</button></form>`; const th = ['id',...configs[table]]; $(`${table}Table`).innerHTML = `<thead><tr>${th.map(h=>`<th>${labels(h)}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map(r=>`<tr>${th.map(h=>`<td>${r[h]??''}</td>`).join('')}<td><button onclick="deleteRow('${table}',${r.id})">Delete</button></td></tr>`).join('')}</tbody>`; }
async function createRow(e, table){ e.preventDefault(); const data = Object.fromEntries(new FormData(e.target).entries()); Object.keys(data).forEach(k=>{if(data[k]==='') delete data[k]}); await api(`/api/${table}`, {method:'POST', body:JSON.stringify(data)}); e.target.reset(); loadTable(table); }
async function deleteRow(table,id){ if(confirm('Delete this record?')){ await api(`/api/${table}/${id}`,{method:'DELETE'}); loadTable(table); } }
async function loadDirectory(){ const q = encodeURIComponent($('search')?.value || ''); const rows = await api(`/api/people-directory?q=${q}`); $('directoryRows').innerHTML = rows.map(e=>`<div class="person-card"><h3>${e.first_name} ${e.last_name}</h3><p>${e.title||''}<br><span class="muted">${e.team_name||'No team'} · ${e.location||''}</span></p><p>${(e.skills||'').split(',').filter(Boolean).map(s=>`<span class="tag">${s.trim()}</span>`).join('')}</p><button onclick="talentMemo(${e.id})">Generate talent memo</button><pre id="memo-${e.id}"></pre></div>`).join(''); }
async function talentMemo(id){ const r = await api(`/api/ai/talent-memo/${id}`,{method:'POST'}); $(`memo-${id}`).textContent = r.memo; }
async function loadOrg(){ const rows = await api('/api/org-chart'); const byManager = {}; rows.forEach(r => { const key = r.manager_id || 'root'; (byManager[key] ||= []).push(r); }); const render = parent => `<ul>${(byManager[parent]||[]).map(e=>`<li><strong>${e.name}</strong><br><span class="muted">${e.title||''} · ${e.team||''}</span>${render(e.id)}</li>`).join('')}</ul>`; $('orgChart').innerHTML = render('root'); }
boot();
