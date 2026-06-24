const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');

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
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000*60*60*8 }
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
async function ensureColumn(table, column, definition) {
  const cols = await all(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
async function seedDefaultSettings() {
  const defaults = {
    theme: JSON.stringify({ brand:'#7c3aed', brandDark:'#5b21b6', accent:'#c084fc', bg:'#f7f2ff', ink:'#24113f' }),
    tabs: JSON.stringify({ dashboard:'Dashboard', directory:'People Directory', teams:'Teams', employees:'Employees', projects:'Projects', tasks:'Tasks', achievements:'Achievements', progression:'Career Progression', actions:'Talent Action Plan', development:'Talent Development', org:'Org Chart', hr:'HR Secure Info', settings:'Settings', users:'Users' }),
    dashboardCards: JSON.stringify(['employees','teams','openActions','developmentPlans','projects','openTasks'])
  };
  for (const [key, value] of Object.entries(defaults)) {
    await run('INSERT OR IGNORE INTO app_settings (key,value) VALUES (?,?)', [key, value]);
  }
}
function requireAuth(req, res, next) { if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' }); next(); }
function requireAdmin(req, res, next) { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' }); next(); }
function userRole(req) { return req.session.user?.role || 'user'; }
function isAdmin(req) { return userRole(req) === 'admin'; }
function isManager(req) { return userRole(req) === 'manager'; }
function isHr(req) { return userRole(req) === 'hr'; }
function isUser(req) { return userRole(req) === 'user'; }
function requireHr(req, res, next) { if (!req.session.user || req.session.user.role !== 'hr') return res.status(403).json({ error: 'HR only' }); next(); }
async function currentEmployeeId(req) {
  if (req.session.user?.employee_id) return req.session.user.employee_id;
  const employee = await get('SELECT id FROM employees WHERE lower(email)=lower(?)', [req.session.user?.email || '']);
  return employee?.id || null;
}
async function managedEmployeeIds(req) {
  const managerId = await currentEmployeeId(req);
  if (!managerId) return [];
  const rows = await all('SELECT id FROM employees WHERE manager_id=?', [managerId]);
  return rows.map(r => r.id);
}
function placeholders(values) { return values.map(() => '?').join(','); }

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, role TEXT DEFAULT 'admin', employee_id INTEGER, password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id))`);
  await run(`CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, title TEXT, email TEXT UNIQUE, location TEXT, manager_id INTEGER, team_id INTEGER, start_date TEXT, level TEXT, status TEXT DEFAULT 'Active', skills TEXT, bio TEXT, photo_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(team_id) REFERENCES teams(id), FOREIGN KEY(manager_id) REFERENCES employees(id))`);
  await run(`CREATE TABLE IF NOT EXISTS achievements (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, achievement_date TEXT, category TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS career_progression (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, from_role TEXT, to_role TEXT, progression_date TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS action_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, title TEXT NOT NULL, objective TEXT, owner TEXT, due_date TEXT, status TEXT DEFAULT 'Open', created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS development_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, skill_area TEXT NOT NULL, development_goal TEXT, learning_actions TEXT, target_date TEXT, status TEXT DEFAULT 'In progress', created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, owner_employee_id INTEGER, team_id INTEGER, status TEXT DEFAULT 'Planning', start_date TEXT, end_date TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(owner_employee_id) REFERENCES employees(id), FOREIGN KEY(team_id) REFERENCES teams(id))`);
  await run(`CREATE TABLE IF NOT EXISTS employee_private_info (employee_id INTEGER PRIMARY KEY, salary REAL, bonus REAL, visa_status TEXT, visa_expiry_date TEXT, job_grade TEXT, birthday TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS salary_history (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, salary REAL NOT NULL, effective_date TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await run(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, assigned_employee_id INTEGER, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'Open', priority TEXT DEFAULT 'Medium', due_date TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL, FOREIGN KEY(assigned_employee_id) REFERENCES employees(id) ON DELETE SET NULL)`);
  await ensureColumn('users', 'employee_id', 'INTEGER');
  await ensureColumn('employees', 'photo_url', 'TEXT');
  await seedDefaultSettings();
  const adminEmail = process.env.ADMIN_EMAIL || 'carlota.moron.ortiz@h-partners.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'CHANGE_ME_IN_RENDER';
  const existingAdmin = await get('SELECT id FROM users WHERE role=?', ['admin']);
  if (existingAdmin) {
    await run('UPDATE users SET email=?, password_hash=? WHERE id=?', [adminEmail, hashPassword(adminPassword), existingAdmin.id]);
  } else {
    await run('INSERT INTO users (name,email,role,password_hash) VALUES (?,?,?,?)', ['Admin', adminEmail, 'admin', hashPassword(adminPassword)]);
  }
  const cnt = await get('SELECT COUNT(*) as n FROM teams');
  if (cnt.n === 0) {
    await run('INSERT INTO teams (name,description) VALUES (?,?)', ['Research', 'Core research team']);
    await run('INSERT INTO teams (name,description) VALUES (?,?)', ['People & Operations', 'HR and operations']);
    await run('INSERT INTO employees (first_name,last_name,title,email,location,team_id,level,skills,bio) VALUES (?,?,?,?,?,?,?,?,?)', ['Paolo','Rossi','Research Manager','paolo@example.com','Switzerland',1,'M4','Battery modelling, BMS, MATLAB','Example manager profile']);
    await run('INSERT INTO employees (first_name,last_name,title,email,location,team_id,manager_id,level,skills,bio) VALUES (?,?,?,?,?,?,?,?,?,?)', ['Maya','Chen','Researcher','maya@example.com','Switzerland',1,1,'IC3','Python, Energy storage, Optimization','Example employee profile']);
  }
}

app.post('/api/login', async (req,res)=>{ const { email, password } = req.body; const user = await get('SELECT * FROM users WHERE email=?', [email]); if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error:'Invalid login' }); req.session.user = { id:user.id, name:user.name, email:user.email, role:user.role, employee_id:user.employee_id }; res.json({ user:req.session.user }); });
app.post('/api/logout', (req,res)=> req.session.destroy(()=>res.json({ ok:true })));
app.get('/api/me', (req,res)=> res.json({ user:req.session.user || null }));

app.get('/api/dashboard', requireAuth, async (req,res)=>{
  if (isAdmin(req)) {
    const [employees, teams, openActions, devPlans, projects, openTasks] = await Promise.all([
      get('SELECT COUNT(*) n FROM employees WHERE status="Active"'), get('SELECT COUNT(*) n FROM teams'), get('SELECT COUNT(*) n FROM action_plans WHERE status != "Done"'), get('SELECT COUNT(*) n FROM development_plans WHERE status != "Done"'), get('SELECT COUNT(*) n FROM projects'), get('SELECT COUNT(*) n FROM tasks WHERE status != "Done"')
    ]);
    return res.json({ employees: employees.n, teams: teams.n, openActions: openActions.n, developmentPlans: devPlans.n, projects: projects.n, openTasks: openTasks.n });
  }
  const employees = await scopedRows(req, 'employees');
  const ids = employees.map(e => e.id);
  const openActions = ids.length ? await get(`SELECT COUNT(*) n FROM action_plans WHERE status != "Done" AND employee_id IN (${placeholders(ids)})`, ids) : {n:0};
  const devPlans = ids.length ? await get(`SELECT COUNT(*) n FROM development_plans WHERE status != "Done" AND employee_id IN (${placeholders(ids)})`, ids) : {n:0};
  const openTasks = ids.length ? await get(`SELECT COUNT(*) n FROM tasks WHERE status != "Done" AND assigned_employee_id IN (${placeholders(ids)})`, ids) : {n:0};
  res.json({ employees: employees.length, openActions: openActions.n, developmentPlans: devPlans.n, openTasks: openTasks.n });
});

async function scopedRows(req, table) {
  if (isAdmin(req) || isHr(req)) return all(`SELECT * FROM ${table} ORDER BY id DESC`);
  const selfId = await currentEmployeeId(req);
  const managed = isManager(req) ? await managedEmployeeIds(req) : [];
  const allowed = [...new Set([selfId, ...managed].filter(Boolean))];
  if (table === 'employees') return allowed.length ? all(`SELECT * FROM employees WHERE id IN (${placeholders(allowed)}) ORDER BY id DESC`, allowed) : [];
  const employeeField = table === 'tasks' ? 'assigned_employee_id' : 'employee_id';
  if (['tasks','achievements','career_progression','action_plans','development_plans'].includes(table)) {
    return allowed.length ? all(`SELECT * FROM ${table} WHERE ${employeeField} IN (${placeholders(allowed)}) ORDER BY id DESC`, allowed) : [];
  }
  if (['teams','projects'].includes(table)) return isManager(req) ? all(`SELECT * FROM ${table} ORDER BY id DESC`) : [];
  return [];
}
async function canWrite(req, table, body, id=null) {
  if (isAdmin(req) || isHr(req)) return true;
  const selfId = await currentEmployeeId(req);
  const managed = isManager(req) ? await managedEmployeeIds(req) : [];
  const current = id ? await get(`SELECT * FROM ${table} WHERE id=?`, [id]) : null;
  const target = Number(body.employee_id ?? body.assigned_employee_id ?? current?.employee_id ?? current?.assigned_employee_id ?? (table === 'employees' ? id : null));
  if (isManager(req) && ['tasks','action_plans','development_plans','achievements'].includes(table)) return managed.includes(target);
  if (isUser(req) && table === 'employees') return Number(id) === selfId;
  if (isUser(req)) return table === 'tasks' && target === selfId && id;
  return false;
}
function crud(table, fields) {
  app.get(`/api/${table}`, requireAuth, async (req,res)=> res.json(await scopedRows(req, table)));
  app.post(`/api/${table}`, requireAuth, async (req,res)=>{ if (!(await canWrite(req, table, req.body))) return res.status(403).json({ error:'Not allowed' }); const cols = fields.filter(f => req.body[f] !== undefined); const vals = cols.map(f=>req.body[f]); const q = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`; const r = await run(q, vals); res.json(await get(`SELECT * FROM ${table} WHERE id=?`, [r.lastID])); });
  app.put(`/api/${table}/:id`, requireAuth, async (req,res)=>{ if (!(await canWrite(req, table, req.body, req.params.id))) return res.status(403).json({ error:'Not allowed' }); const cols = fields.filter(f => req.body[f] !== undefined); await run(`UPDATE ${table} SET ${cols.map(f=>`${f}=?`).join(',')} WHERE id=?`, [...cols.map(f=>req.body[f]), req.params.id]); res.json(await get(`SELECT * FROM ${table} WHERE id=?`, [req.params.id])); });
  app.delete(`/api/${table}/:id`, requireAdmin, async (req,res)=>{ await run(`DELETE FROM ${table} WHERE id=?`, [req.params.id]); res.json({ ok:true }); });
}
crud('teams', ['name','description']);
crud('employees', ['first_name','last_name','title','email','location','manager_id','team_id','start_date','level','status','skills','bio','photo_url']);
crud('achievements', ['employee_id','title','description','achievement_date','category']);
crud('career_progression', ['employee_id','from_role','to_role','progression_date','notes']);
crud('action_plans', ['employee_id','title','objective','owner','due_date','status']);
crud('development_plans', ['employee_id','skill_area','development_goal','learning_actions','target_date','status']);
crud('projects', ['name','description','owner_employee_id','team_id','status','start_date','end_date']);
crud('tasks', ['project_id','assigned_employee_id','title','description','status','priority','due_date']);

app.get('/api/settings', requireAuth, async (req,res)=>{ const rows = await all('SELECT key,value FROM app_settings'); res.json(Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]))); });
app.put('/api/settings', requireAdmin, async (req,res)=>{ for (const key of ['theme','tabs','dashboardCards']) if (req.body[key]) await run('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)', [key, JSON.stringify(req.body[key])]); res.json({ ok:true }); });
app.get('/api/users', requireAdmin, async (req,res)=> res.json(await all('SELECT id,name,email,role,employee_id,created_at FROM users ORDER BY id DESC')));
app.post('/api/users', requireAdmin, async (req,res)=>{ const {name,email,role='user',employee_id,password='ChangeMe123!'} = req.body; const r = await run('INSERT INTO users (name,email,role,employee_id,password_hash) VALUES (?,?,?,?,?)', [name,email,role,employee_id || null,hashPassword(password)]); res.json(await get('SELECT id,name,email,role,employee_id,created_at FROM users WHERE id=?', [r.lastID])); });
app.put('/api/users/:id', requireAdmin, async (req,res)=>{ const {name,email,role,employee_id,password} = req.body; const cols = ['name','email','role','employee_id'].filter(f => req.body[f] !== undefined); const vals = cols.map(f => f === 'employee_id' && req.body[f] === '' ? null : req.body[f]); if (password) { cols.push('password_hash'); vals.push(hashPassword(password)); } await run(`UPDATE users SET ${cols.map(f=>`${f}=?`).join(',')} WHERE id=?`, [...vals, req.params.id]); res.json(await get('SELECT id,name,email,role,employee_id,created_at FROM users WHERE id=?', [req.params.id])); });
app.delete('/api/users/:id', requireAdmin, async (req,res)=>{ await run('DELETE FROM users WHERE id=?', [req.params.id]); res.json({ ok:true }); });

app.get('/api/hr-info', requireHr, async (req,res)=>{
  res.json(await all(`SELECT e.id AS employee_id, e.first_name, e.last_name, e.email, e.title, h.salary, h.bonus, h.visa_status, h.visa_expiry_date, h.job_grade, h.birthday, h.updated_at
    FROM employees e LEFT JOIN employee_private_info h ON h.employee_id=e.id ORDER BY e.last_name, e.first_name`));
});
app.put('/api/hr-info/:employeeId', requireHr, async (req,res)=>{
  const employeeId = req.params.employeeId;
  const before = await get('SELECT salary FROM employee_private_info WHERE employee_id=?', [employeeId]);
  const values = {
    salary:req.body.salary ?? null,
    bonus:req.body.bonus ?? null,
    visa_status:req.body.visa_status ?? null,
    visa_expiry_date:req.body.visa_expiry_date ?? null,
    job_grade:req.body.job_grade ?? null,
    birthday:req.body.birthday ?? null
  };
  await run(`INSERT INTO employee_private_info (employee_id,salary,bonus,visa_status,visa_expiry_date,job_grade,birthday,updated_at)
    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(employee_id) DO UPDATE SET salary=excluded.salary, bonus=excluded.bonus, visa_status=excluded.visa_status, visa_expiry_date=excluded.visa_expiry_date, job_grade=excluded.job_grade, birthday=excluded.birthday, updated_at=CURRENT_TIMESTAMP`,
    [employeeId, values.salary, values.bonus, values.visa_status, values.visa_expiry_date, values.job_grade, values.birthday]);
  if (values.salary !== null && Number(values.salary) !== Number(before?.salary)) {
    await run('INSERT INTO salary_history (employee_id,salary,effective_date,notes) VALUES (?,?,?,?)', [employeeId, values.salary, req.body.salary_effective_date || new Date().toISOString().slice(0,10), req.body.salary_notes || 'Salary updated']);
  }
  res.json(await get('SELECT * FROM employee_private_info WHERE employee_id=?', [employeeId]));
});
app.get('/api/hr-info/:employeeId/salary-history', requireHr, async (req,res)=> res.json(await all('SELECT * FROM salary_history WHERE employee_id=? ORDER BY effective_date DESC, id DESC', [req.params.employeeId])));
app.post('/api/hr-info/:employeeId/salary-history', requireHr, async (req,res)=>{ const r = await run('INSERT INTO salary_history (employee_id,salary,effective_date,notes) VALUES (?,?,?,?)', [req.params.employeeId, req.body.salary, req.body.effective_date, req.body.notes]); res.json(await get('SELECT * FROM salary_history WHERE id=?', [r.lastID])); });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}
function pick(row, names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') return String(row[n]).trim();
  }
  return '';
}
async function getOrCreateTeam(name) {
  if (!name) return null;
  let team = await get('SELECT id FROM teams WHERE lower(name)=lower(?)', [name]);
  if (team) return team.id;
  const r = await run('INSERT INTO teams (name,description) VALUES (?,?)', [name, 'Created from employee import']);
  return r.lastID;
}
async function findManagerId(managerText) {
  if (!managerText) return null;
  const text = String(managerText).trim();
  let manager = await get('SELECT id FROM employees WHERE lower(email)=lower(?)', [text]);
  if (manager) return manager.id;
  const parts = text.split(/\s+/);
  if (parts.length >= 2) {
    manager = await get('SELECT id FROM employees WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?)', [parts[0], parts.slice(1).join(' ')]);
    if (manager) return manager.id;
  }
  return null;
}

app.post('/api/import/employees', requireAdmin, upload.single('file'), async (req,res)=>{
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }).map(raw => {
    const out = {};
    for (const [k,v] of Object.entries(raw)) out[normalizeHeader(k)] = v;
    return out;
  });
  let created = 0, updated = 0, skipped = 0;
  const errors = [];
  for (let i=0; i<rows.length; i++) {
    const row = rows[i];
    try {
      const fullName = pick(row, ['name','full_name','employee_name']);
      let first = pick(row, ['first_name','firstname','first']);
      let last = pick(row, ['last_name','lastname','surname','last']);
      if ((!first || !last) && fullName) {
        const parts = fullName.split(/\s+/);
        first = first || parts[0] || '';
        last = last || parts.slice(1).join(' ') || '';
      }
      const email = pick(row, ['email','work_email','employee_email']);
      if (!first || !last || !email) { skipped++; errors.push(`Row ${i+2}: first name, last name and email are required`); continue; }
      const teamName = pick(row, ['team','department','org','organization']);
      const teamId = await getOrCreateTeam(teamName);
      const managerText = pick(row, ['manager','manager_email','line_manager']);
      const managerId = await findManagerId(managerText);
      const values = {
        first_name:first,
        last_name:last,
        title:pick(row, ['title','job_title','role','position']),
        email,
        location:pick(row, ['location','country','site']),
        manager_id:managerId,
        team_id:teamId,
        start_date:pick(row, ['start_date','startdate','hire_date','join_date']),
        level:pick(row, ['level','grade']),
        status:pick(row, ['status']) || 'Active',
        skills:pick(row, ['skills','expertise','competencies']),
        bio:pick(row, ['bio','summary','notes'])
      };
      const existing = await get('SELECT id FROM employees WHERE lower(email)=lower(?)', [email]);
      if (existing) {
        await run(`UPDATE employees SET first_name=?, last_name=?, title=?, location=?, manager_id=?, team_id=?, start_date=?, level=?, status=?, skills=?, bio=? WHERE id=?`,
          [values.first_name,values.last_name,values.title,values.location,values.manager_id,values.team_id,values.start_date,values.level,values.status,values.skills,values.bio,existing.id]);
        updated++;
      } else {
        await run(`INSERT INTO employees (first_name,last_name,title,email,location,manager_id,team_id,start_date,level,status,skills,bio) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [values.first_name,values.last_name,values.title,values.email,values.location,values.manager_id,values.team_id,values.start_date,values.level,values.status,values.skills,values.bio]);
        created++;
      }
    } catch (err) {
      skipped++; errors.push(`Row ${i+2}: ${err.message}`);
    }
  }
  res.json({ created, updated, skipped, errors: errors.slice(0,20) });
});

app.get('/api/people-directory', requireAuth, async (req,res)=>{
  const q = `%${req.query.q || ''}%`;
  const scoped = await scopedRows(req, 'employees');
  const ids = scoped.map(e => e.id);
  if (!ids.length) return res.json([]);
  res.json(await all(`SELECT e.*, t.name AS team_name, m.first_name || ' ' || m.last_name AS manager_name FROM employees e LEFT JOIN teams t ON e.team_id=t.id LEFT JOIN employees m ON e.manager_id=m.id WHERE e.id IN (${placeholders(ids)}) AND (e.first_name LIKE ? OR e.last_name LIKE ? OR e.title LIKE ? OR e.skills LIKE ? OR t.name LIKE ?) ORDER BY e.last_name`, [...ids,q,q,q,q,q]));
});
app.get('/api/org-chart', requireAuth, async (req,res)=>{
  if (isAdmin(req)) return res.json(await all(`SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.title, e.manager_id, t.name AS team FROM employees e LEFT JOIN teams t ON e.team_id=t.id WHERE e.status='Active' ORDER BY e.manager_id`));
  const scoped = await scopedRows(req, 'employees');
  const ids = scoped.map(e => e.id);
  if (!ids.length) return res.json([]);
  res.json(await all(`SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.title, e.manager_id, t.name AS team FROM employees e LEFT JOIN teams t ON e.team_id=t.id WHERE e.status='Active' AND e.id IN (${placeholders(ids)}) ORDER BY e.manager_id`, ids));
});
app.get('/api/employees/:id/profile', requireAuth, async (req,res)=>{
  const id = req.params.id;
  if (!isAdmin(req)) {
    const allowed = (await scopedRows(req, 'employees')).map(e => Number(e.id));
    if (!allowed.includes(Number(id))) return res.status(403).json({ error:'Not allowed' });
  }
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
    app.listen(PORT, '0.0.0.0', () => console.log(`HR platform running on ${PORT}`));
  })
  .catch(err => {
    console.error('Startup error:', err);
    process.exit(1);
  });