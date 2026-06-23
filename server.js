const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, 'hr.sqlite');
const db = new sqlite3.Database(dbPath);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'change-me-in-render-env',
  resave: false,
  saveUninitialized: false,
 cookie: {
  httpOnly: true,
  sameSite: 'lax',
  secure: false,
  maxAge: 1000 * 60 * 60 * 8
}));
app.use(express.static(path.join(__dirname, 'public')));

function run(sql, params=[]) { return new Promise((res, rej)=> db.run(sql, params, function(err){ err ? rej(err) : res(this); })); }
function all(sql, params=[]) { return new Promise((res, rej)=> db.all(sql, params, (err, rows)=> err ? rej(err) : res(rows))); }
function get(sql, params=[]) { return new Promise((res, rej)=> db.get(sql, params, (err, row)=> err ? rej(err) : res(row))); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, original] = stored.split(':');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(original, 'hex'));
}
function requireAuth(req, res, next) { if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' }); next(); }
function requireAdmin(req, res, next) { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' }); next(); }

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, role TEXT DEFAULT 'admin', password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, title TEXT, email TEXT UNIQUE, location TEXT, manager_id INTEGER, team_id INTEGER, start_date TEXT, level TEXT, status TEXT DEFAULT 'Active', skills TEXT, bio TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(team_id) REFERENCES teams(id), FOREIGN KEY(manager_id) REFERENCES employees(id))`);
  await run(`CREATE TABLE IF NOT EXISTS achievements (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, achievement_date TEXT, category TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS career_progression (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, from_role TEXT, to_role TEXT, progression_date TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS action_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, title TEXT NOT NULL, objective TEXT, owner TEXT, due_date TEXT, status TEXT DEFAULT 'Open', created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS development_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, skill_area TEXT NOT NULL, development_goal TEXT, learning_actions TEXT, target_date TEXT, status TEXT DEFAULT 'In progress', created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  const admin = await get('SELECT id FROM users WHERE email=?', [process.env.ADMIN_EMAIL || 'admin@example.com']);
  if (!admin) await run('INSERT INTO users (name,email,role,password_hash) VALUES (?,?,?,?)', ['Admin', process.env.ADMIN_EMAIL || 'admin@example.com', 'admin', hashPassword(process.env.ADMIN_PASSWORD || 'admin123')]);
  const cnt = await get('SELECT COUNT(*) as n FROM teams');
  if (cnt.n === 0) {
    await run('INSERT INTO teams (name,description) VALUES (?,?)', ['Research', 'Core research team']);
    await run('INSERT INTO teams (name,description) VALUES (?,?)', ['People & Operations', 'HR and operations']);
    await run('INSERT INTO employees (first_name,last_name,title,email,location,team_id,level,skills,bio) VALUES (?,?,?,?,?,?,?,?,?)', ['Paolo','Rossi','Research Manager','paolo@example.com','Switzerland',1,'M4','Battery modelling, BMS, MATLAB','Example manager profile']);
    await run('INSERT INTO employees (first_name,last_name,title,email,location,team_id,manager_id,level,skills,bio) VALUES (?,?,?,?,?,?,?,?,?,?)', ['Maya','Chen','Researcher','maya@example.com','Switzerland',1,1,'IC3','Python, Energy storage, Optimization','Example employee profile']);
  }
}

app.post('/api/login', async (req,res)=>{ const { email, password } = req.body; const user = await get('SELECT * FROM users WHERE email=?', [email]); if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error:'Invalid login' }); req.session.user = { id:user.id, name:user.name, email:user.email, role:user.role }; res.json({ user:req.session.user }); });
app.post('/api/logout', (req,res)=> req.session.destroy(()=>res.json({ ok:true })));
app.get('/api/me', (req,res)=> res.json({ user:req.session.user || null }));

app.get('/api/dashboard', requireAuth, async (req,res)=>{
  const [employees, teams, openActions, devPlans] = await Promise.all([
    get('SELECT COUNT(*) n FROM employees WHERE status="Active"'), get('SELECT COUNT(*) n FROM teams'), get('SELECT COUNT(*) n FROM action_plans WHERE status != "Done"'), get('SELECT COUNT(*) n FROM development_plans WHERE status != "Done"')
  ]);
  res.json({ employees: employees.n, teams: teams.n, openActions: openActions.n, developmentPlans: devPlans.n });
});

function crud(table, fields) {
  app.get(`/api/${table}`, requireAuth, async (req,res)=> res.json(await all(`SELECT * FROM ${table} ORDER BY id DESC`)));
  app.post(`/api/${table}`, requireAuth, async (req,res)=>{ const cols = fields.filter(f => req.body[f] !== undefined); const vals = cols.map(f=>req.body[f]); const q = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`; const r = await run(q, vals); res.json(await get(`SELECT * FROM ${table} WHERE id=?`, [r.lastID])); });
  app.put(`/api/${table}/:id`, requireAuth, async (req,res)=>{ const cols = fields.filter(f => req.body[f] !== undefined); await run(`UPDATE ${table} SET ${cols.map(f=>`${f}=?`).join(',')} WHERE id=?`, [...cols.map(f=>req.body[f]), req.params.id]); res.json(await get(`SELECT * FROM ${table} WHERE id=?`, [req.params.id])); });
  app.delete(`/api/${table}/:id`, requireAdmin, async (req,res)=>{ await run(`DELETE FROM ${table} WHERE id=?`, [req.params.id]); res.json({ ok:true }); });
}
crud('teams', ['name','description']);
crud('employees', ['first_name','last_name','title','email','location','manager_id','team_id','start_date','level','status','skills','bio']);
crud('achievements', ['employee_id','title','description','achievement_date','category']);
crud('career_progression', ['employee_id','from_role','to_role','progression_date','notes']);
crud('action_plans', ['employee_id','title','objective','owner','due_date','status']);
crud('development_plans', ['employee_id','skill_area','development_goal','learning_actions','target_date','status']);

app.get('/api/people-directory', requireAuth, async (req,res)=>{
  const q = `%${req.query.q || ''}%`;
  res.json(await all(`SELECT e.*, t.name AS team_name, m.first_name || ' ' || m.last_name AS manager_name FROM employees e LEFT JOIN teams t ON e.team_id=t.id LEFT JOIN employees m ON e.manager_id=m.id WHERE e.first_name LIKE ? OR e.last_name LIKE ? OR e.title LIKE ? OR e.skills LIKE ? OR t.name LIKE ? ORDER BY e.last_name`, [q,q,q,q,q]));
});
app.get('/api/org-chart', requireAuth, async (req,res)=>{
  const rows = await all(`SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.title, e.manager_id, t.name AS team FROM employees e LEFT JOIN teams t ON e.team_id=t.id WHERE e.status='Active' ORDER BY e.manager_id`);
  res.json(rows);
});
app.get('/api/employees/:id/profile', requireAuth, async (req,res)=>{
  const id = req.params.id;
  const [employee, achievements, progression, actions, development] = await Promise.all([
    get('SELECT e.*, t.name AS team_name, m.first_name || " " || m.last_name AS manager_name FROM employees e LEFT JOIN teams t ON e.team_id=t.id LEFT JOIN employees m ON e.manager_id=m.id WHERE e.id=?',[id]),
    all('SELECT * FROM achievements WHERE employee_id=? ORDER BY achievement_date DESC',[id]),
    all('SELECT * FROM career_progression WHERE employee_id=? ORDER BY progression_date DESC',[id]),
    all('SELECT * FROM action_plans WHERE employee_id=? ORDER BY due_date',[id]),
    all('SELECT * FROM development_plans WHERE employee_id=? ORDER BY target_date',[id])
  ]);
  if (!employee) return res.status(404).json({ error:'Employee not found' });
  res.json({ employee, achievements, progression, actions, development });
});
app.post('/api/ai/talent-memo/:id', requireAuth, async (req,res)=>{
  const profile = await (await fetch(`http://localhost:${PORT}/api/employees/${req.params.id}/profile`, { headers: { cookie: req.headers.cookie || '' }})).json().catch(()=>null);
  if (!profile || profile.error) return res.status(404).json({ error:'Employee not found' });
  const e = profile.employee;
  const memo = `Talent memo for ${e.first_name} ${e.last_name}\n\nRole: ${e.title || 'N/A'} | Team: ${e.team_name || 'N/A'} | Level: ${e.level || 'N/A'}\nSkills: ${e.skills || 'N/A'}\n\nStrengths:\n- ${profile.achievements.length ? profile.achievements.map(a=>a.title).slice(0,3).join('\n- ') : 'Add achievements to generate stronger strengths.'}\n\nCareer progression:\n- ${profile.progression.length ? profile.progression.map(p=>`${p.from_role || 'N/A'} → ${p.to_role || 'N/A'} (${p.progression_date || 'date missing'})`).join('\n- ') : 'No progression records yet.'}\n\nOpen action plan items:\n- ${profile.actions.length ? profile.actions.filter(a=>a.status !== 'Done').map(a=>`${a.title}: ${a.objective || ''}`).join('\n- ') : 'No open action items.'}\n\nDevelopment focus:\n- ${profile.development.length ? profile.development.map(d=>`${d.skill_area}: ${d.development_goal || ''}`).join('\n- ') : 'No development plan yet.'}\n\nRecommendation:\nUse this memo as a first draft. Validate with manager feedback before making HR decisions.`;
  res.json({ memo });
});

app.get('*', (req,res)=> res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`HR platform running on ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Startup error:', err);
    process.exit(1);
  });
