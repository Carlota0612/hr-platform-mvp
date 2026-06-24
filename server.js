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
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || (isProduction ? null : 'dev-only-change-me');
if (!sessionSecret) {
  throw new Error('SESSION_SECRET must be configured in production.');
}
const hrEncryptionSecret = process.env.HR_ENCRYPTION_KEY || (isProduction ? null : 'dev-only-hr-encryption-key');
if (!hrEncryptionSecret) {
  throw new Error('HR_ENCRYPTION_KEY must be configured in production.');
}
const hrEncryptionKey = crypto.createHash('sha256').update(hrEncryptionSecret).digest();
const loginAttempts = new Map();

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: isProduction, maxAge: 1000*60*60*8 }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || ['/api/login','/api/invitations/accept'].includes(req.path)) return next();
  if (req.session.user && req.get('X-CSRF-Token') !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid security token. Refresh the page and try again.' });
  }
  next();
});

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
function encryptSecret(value) {
  if (value === null || value === undefined || value === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', hrEncryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}
function decryptSecret(value) {
  if (value === null || value === undefined || value === '') return value;
  const text = String(value);
  if (!text.startsWith('enc:v1:')) return value;
  const [, , iv, tag, encrypted] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', hrEncryptionKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}
function decryptHrRow(row) {
  if (!row) return row;
  for (const field of ['salary','bonus','visa_status','visa_expiry_date','job_grade','birthday']) row[field] = decryptSecret(row[field]);
  return row;
}
function appBaseUrl(req) { return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`; }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function createInviteToken() { return crypto.randomBytes(32).toString('base64url'); }
async function createUserInvite(req, userId, email) {
  const token = createInviteToken();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  await run('UPDATE user_invites SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL', [userId]);
  await run('INSERT INTO user_invites (user_id,email,token_hash,expires_at,created_by) VALUES (?,?,?,?,?)', [userId, email, sha256(token), expiresAt, req.session.user?.id || null]);
  return { token, invite_url: `${appBaseUrl(req)}/invite?token=${encodeURIComponent(token)}`, invite_expires_at: expiresAt };
}
async function sendInviteEmail(invite) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return { sent:false, reason:'RESEND_API_KEY and EMAIL_FROM not configured' };
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: invite.email,
      subject: 'Activate your PeopleOS account',
      html: `<p>Hello ${invite.name || invite.email},</p><p>You have been invited to PeopleOS. This link expires in 48 hours:</p><p><a href="${invite.invite_url}">Create your password</a></p><p>If you did not expect this invite, ignore this email.</p>`
    })
  });
  if (!response.ok) return { sent:false, reason:`Email provider returned ${response.status}` };
  return { sent:true };
}
function validatePassword(password) {
  if (!password || password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return 'Password must be at least 12 characters and include uppercase, lowercase, number, and symbol.';
  }
  return null;
}
async function ensureColumn(table, column, definition) {
  const cols = await all(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
async function seedDefaultSettings() {
  const defaults = {
    theme: JSON.stringify({ brand:'#7c3aed', brandDark:'#5b21b6', accent:'#c084fc', bg:'#f7f2ff', ink:'#24113f' }),
    tabs: JSON.stringify({ dashboard:'Dashboard', directory:'People Directory', teams:'Teams', employees:'Employees', projects:'Projects', tasks:'Tasks', achievements:'Achievements', progression:'Career Progression', actions:'Talent Action Plan', development:'Talent Development', org:'Org Chart', hr:'HR Secure Info', audit:'Audit Log', settings:'Settings', users:'Users' }),
    dashboardCards: JSON.stringify(['employees','teams','openActions','developmentPlans','projects','openTasks']),
    taskStatuses: JSON.stringify(['Not started','In progress','Done','On hold'])
  };
  for (const [key, value] of Object.entries(defaults)) {
    await run('INSERT OR IGNORE INTO app_settings (key,value) VALUES (?,?)', [key, value]);
  }
}
function normalizeRoles(value) {
  const roles = Array.isArray(value) ? value : String(value || 'user').split(',');
  const allowed = new Set(['user', 'manager', 'hr', 'admin']);
  const clean = [...new Set(roles.map(r => String(r).trim().toLowerCase()).filter(r => allowed.has(r)))];
  return clean.length ? clean : ['user'];
}
function rolesForUser(user) { return normalizeRoles(user?.roles || user?.role); }
function primaryRole(roles) { return roles.includes('admin') ? 'admin' : roles.includes('hr') ? 'hr' : roles.includes('manager') ? 'manager' : 'user'; }
function requireAuth(req, res, next) { if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' }); next(); }
function hasRole(req, role) { return rolesForUser(req.session.user).includes(role); }
function requireAdmin(req, res, next) { if (!req.session.user || !hasRole(req, 'admin')) return res.status(403).json({ error: 'Admin only' }); next(); }
function requireHr(req, res, next) { if (!req.session.user || !(hasRole(req, 'hr') || hasRole(req, 'admin'))) return res.status(403).json({ error: 'HR only' }); next(); }
function isAdmin(req) { return hasRole(req, 'admin'); }
function isManager(req) { return hasRole(req, 'manager'); }
function isHr(req) { return hasRole(req, 'hr'); }
function isUser(req) { return hasRole(req, 'user') || rolesForUser(req.session.user).length === 0; }
async function auditLog(req, action, targetType, targetId = null, details = {}) {
  await run('INSERT INTO audit_logs (user_id,user_email,action,target_type,target_id,details,ip,user_agent) VALUES (?,?,?,?,?,?,?,?)', [req.session.user?.id || null, req.session.user?.email || null, action, targetType, targetId, JSON.stringify(details), req.ip, req.get('user-agent') || '']);
}
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
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, role TEXT DEFAULT 'admin', employee_id INTEGER, password_hash TEXT NOT NULL, force_password_change INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id))`);
  await run(`CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, title TEXT, email TEXT UNIQUE, location TEXT, manager_id INTEGER, team_id INTEGER, start_date TEXT, level TEXT, status TEXT DEFAULT 'Active', skills TEXT, bio TEXT, photo_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(team_id) REFERENCES teams(id), FOREIGN KEY(manager_id) REFERENCES employees(id))`);
  await run(`CREATE TABLE IF NOT EXISTS achievements (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, achievement_date TEXT, category TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS career_progression (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, from_role TEXT, to_role TEXT, progression_date TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS action_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, title TEXT NOT NULL, objective TEXT, owner TEXT, due_date TEXT, status TEXT DEFAULT 'Open', created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS development_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, skill_area TEXT NOT NULL, development_goal TEXT, learning_actions TEXT, target_date TEXT, status TEXT DEFAULT 'In progress', created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, owner_employee_id INTEGER, team_id INTEGER, status TEXT DEFAULT 'Planning', start_date TEXT, end_date TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(owner_employee_id) REFERENCES employees(id), FOREIGN KEY(team_id) REFERENCES teams(id))`);
  await run(`CREATE TABLE IF NOT EXISTS employee_private_info (employee_id INTEGER PRIMARY KEY, salary REAL, bonus REAL, visa_status TEXT, visa_expiry_date TEXT, job_grade TEXT, birthday TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_email TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT, details TEXT, ip TEXT, user_agent TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS user_invites (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS salary_history (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, salary REAL NOT NULL, effective_date TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await run(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, assigned_employee_id INTEGER, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'Open', priority TEXT DEFAULT 'Medium', due_date TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL, FOREIGN KEY(assigned_employee_id) REFERENCES employees(id) ON DELETE SET NULL)`);
  await ensureColumn('users', 'employee_id', 'INTEGER');
  await ensureColumn('users', 'force_password_change', 'INTEGER DEFAULT 0');
  await ensureColumn('employees', 'photo_url', 'TEXT');
  await seedDefaultSettings();
  const adminEmail = process.env.ADMIN_EMAIL || 'carlota.moron.ortiz@h-partners.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'CHANGE_ME_IN_RENDER';
  if (isProduction && adminPassword === 'CHANGE_ME_IN_RENDER') throw new Error('ADMIN_PASSWORD must be configured in production.');
  const existingAdmin = await get("SELECT id FROM users WHERE role LIKE '%admin%'");
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

app.post('/api/login', async (req,res)=>{
  const { email, password } = req.body;
  const key = `${req.ip}:${String(email || '').toLowerCase()}`;
  const now = Date.now();
  const attempt = loginAttempts.get(key) || { count: 0, first: now };
  if (now - attempt.first > 15 * 60 * 1000) { attempt.count = 0; attempt.first = now; }
  if (attempt.count >= 8) return res.status(429).json({ error:'Too many login attempts. Try again later.' });
  const user = await get('SELECT * FROM users WHERE email=?', [email]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    attempt.count += 1; loginAttempts.set(key, attempt);
    return res.status(401).json({ error:'Invalid login' });
  }
  loginAttempts.delete(key);
  if (user.force_password_change) return res.status(403).json({ error:'Please use your invitation link to set your password before signing in.' });
  const roles = rolesForUser(user);
  req.session.user = { id:user.id, name:user.name, email:user.email, role:primaryRole(roles), roles, employee_id:user.employee_id };
  await auditLog(req, 'login', 'user', user.id);
  res.json({ user:{...req.session.user, csrfToken:req.session.csrfToken} });
});
app.post('/api/logout', (req,res)=> req.session.destroy(()=>res.json({ ok:true })));
app.get('/api/me', (req,res)=> res.json({ user:req.session.user ? {...req.session.user, csrfToken:req.session.csrfToken} : null }));

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
app.put('/api/settings', requireAdmin, async (req,res)=>{ for (const key of ['theme','tabs','dashboardCards','taskStatuses']) if (req.body[key]) await run('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)', [key, JSON.stringify(req.body[key])]); res.json({ ok:true }); });
app.put('/api/tasks/:id/status', requireAuth, async (req,res)=>{ if (!(await canWrite(req, 'tasks', {assigned_employee_id:req.body.assigned_employee_id, status:req.body.status}, req.params.id))) return res.status(403).json({ error:'Not allowed' }); await run('UPDATE tasks SET status=? WHERE id=?', [req.body.status, req.params.id]); await auditLog(req, 'update_task_status', 'task', req.params.id, { status: req.body.status }); res.json(await get('SELECT * FROM tasks WHERE id=?', [req.params.id])); });
app.get('/api/users', requireAdmin, async (req,res)=> res.json(await all('SELECT id,name,email,role,employee_id,force_password_change,created_at FROM users ORDER BY id DESC')));
async function assertNotLastAdmin(userId, nextRoles = null) {
  const current = await get('SELECT role FROM users WHERE id=?', [userId]);
  const currentIsAdmin = normalizeRoles(current?.role).includes('admin');
  const nextIsAdmin = nextRoles ? normalizeRoles(nextRoles).includes('admin') : false;
  if (currentIsAdmin && !nextIsAdmin) {
    const admins = await all("SELECT id FROM users WHERE role LIKE '%admin%'");
    if (admins.length <= 1) throw new Error('At least one admin user is required.');
  }
}
app.get('/api/audit-logs', requireAdmin, async (req,res)=> res.json(await all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 250')));
app.post('/api/users', requireAdmin, async (req,res)=>{ const {name,email,employee_id} = req.body; const roles = normalizeRoles(req.body.roles || req.body.role); const temporaryPassword = crypto.randomBytes(32).toString('base64url') + 'Aa1!'; const r = await run('INSERT INTO users (name,email,role,employee_id,password_hash,force_password_change) VALUES (?,?,?,?,?,?)', [name,email,roles.join(','),employee_id || null,hashPassword(temporaryPassword),1]); const invite = await createUserInvite(req, r.lastID, email); const emailResult = await sendInviteEmail({...invite, email, name}); await auditLog(req, 'create_user_invite', 'user', r.lastID, { roles, emailSent: emailResult.sent }); const user = await get('SELECT id,name,email,role,employee_id,force_password_change,created_at FROM users WHERE id=?', [r.lastID]); res.json({...user, ...invite, email_sent: emailResult.sent, email_note: emailResult.reason || null}); });

app.post('/api/users/:id/invite', requireAdmin, async (req,res)=>{
  const user = await get('SELECT id,name,email FROM users WHERE id=?', [req.params.id]);
  if (!user) return res.status(404).json({ error:'User not found' });
  await run('UPDATE users SET force_password_change=1 WHERE id=?', [user.id]);
  const invite = await createUserInvite(req, user.id, user.email);
  const emailResult = await sendInviteEmail({...invite, email:user.email, name:user.name});
  await auditLog(req, 'resend_user_invite', 'user', user.id, { emailSent: emailResult.sent });
  res.json({...invite, email_sent: emailResult.sent, email_note: emailResult.reason || null});
});
app.get('/api/invitations/:token', async (req,res)=>{
  const invite = await get(`SELECT i.id, i.email, i.expires_at, i.used_at, u.name FROM user_invites i JOIN users u ON u.id=i.user_id WHERE i.token_hash=?`, [sha256(req.params.token)]);
  if (!invite || invite.used_at || new Date(invite.expires_at).getTime() < Date.now()) return res.status(404).json({ error:'Invitation is invalid or expired.' });
  res.json({ name:invite.name, email:invite.email, expires_at:invite.expires_at });
});
app.post('/api/invitations/accept', async (req,res)=>{
  const { token, password } = req.body;
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const invite = await get(`SELECT i.id, i.user_id, i.email, i.expires_at, i.used_at FROM user_invites i WHERE i.token_hash=?`, [sha256(token)]);
  if (!invite || invite.used_at || new Date(invite.expires_at).getTime() < Date.now()) return res.status(404).json({ error:'Invitation is invalid or expired.' });
  await run('UPDATE users SET password_hash=?, force_password_change=0 WHERE id=?', [hashPassword(password), invite.user_id]);
  await run('UPDATE user_invites SET used_at=CURRENT_TIMESTAMP WHERE id=?', [invite.id]);
  await run('UPDATE user_invites SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL', [invite.user_id]);
  await run('INSERT INTO audit_logs (user_id,user_email,action,target_type,target_id,details,ip,user_agent) VALUES (?,?,?,?,?,?,?,?)', [invite.user_id, invite.email, 'accept_user_invite', 'user', invite.user_id, '{}', req.ip, req.get('user-agent') || '']);
  res.json({ ok:true });
});

app.put('/api/users/:id', requireAdmin, async (req,res)=>{ const {password} = req.body; const body = {...req.body}; if (body.roles || body.role) body.role = normalizeRoles(body.roles || body.role).join(','); if (body.role) { try { await assertNotLastAdmin(req.params.id, body.role); } catch (err) { return res.status(400).json({ error: err.message }); } } const cols = ['name','email','role','employee_id','force_password_change'].filter(f => body[f] !== undefined); const vals = cols.map(f => f === 'employee_id' && body[f] === '' ? null : body[f]); if (password) { const passwordError = validatePassword(password); if (passwordError) return res.status(400).json({ error: passwordError }); cols.push('password_hash'); vals.push(hashPassword(password)); cols.push('force_password_change'); vals.push(1); } await run(`UPDATE users SET ${cols.map(f=>`${f}=?`).join(',')} WHERE id=?`, [...vals, req.params.id]); await auditLog(req, 'update_user', 'user', req.params.id, { roles: body.role }); res.json(await get('SELECT id,name,email,role,employee_id,force_password_change,created_at FROM users WHERE id=?', [req.params.id])); });
app.delete('/api/users/:id', requireAdmin, async (req,res)=>{ try { await assertNotLastAdmin(req.params.id, []); } catch (err) { return res.status(400).json({ error: err.message }); } await run('DELETE FROM users WHERE id=?', [req.params.id]); await auditLog(req, 'delete_user', 'user', req.params.id); res.json({ ok:true }); });


app.get('/api/hr-info', requireHr, async (req,res)=>{
  await auditLog(req, 'view_hr_info', 'employee_private_info');
  const rows = await all(`SELECT e.id AS employee_id, e.first_name, e.last_name, e.email, e.title, h.salary, h.bonus, h.visa_status, h.visa_expiry_date, h.job_grade, h.birthday, h.updated_at
    FROM employees e LEFT JOIN employee_private_info h ON h.employee_id=e.id ORDER BY e.last_name, e.first_name`);
  res.json(rows.map(decryptHrRow));
});
app.put('/api/hr-info/:employeeId', requireHr, async (req,res)=>{
  const employeeId = req.params.employeeId;
  const before = await get('SELECT salary FROM employee_private_info WHERE employee_id=?', [employeeId]);
  const beforeSalary = decryptSecret(before?.salary);
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
    [employeeId, encryptSecret(values.salary), encryptSecret(values.bonus), encryptSecret(values.visa_status), encryptSecret(values.visa_expiry_date), encryptSecret(values.job_grade), encryptSecret(values.birthday)]);
  const salaryChanged = values.salary !== null && Number(values.salary) !== Number(beforeSalary);
  if (salaryChanged) {
    await run('INSERT INTO salary_history (employee_id,salary,effective_date,notes) VALUES (?,?,?,?)', [employeeId, encryptSecret(values.salary), req.body.salary_effective_date || new Date().toISOString().slice(0,10), encryptSecret(req.body.salary_notes || 'Salary updated')]);
  }
  await auditLog(req, 'update_hr_info', 'employee_private_info', employeeId, { salaryChanged });
  res.json(decryptHrRow(await get('SELECT * FROM employee_private_info WHERE employee_id=?', [employeeId])));
});
app.get('/api/hr-info/:employeeId/salary-history', requireHr, async (req,res)=>{ await auditLog(req, 'view_salary_history', 'salary_history', req.params.employeeId); const rows = await all('SELECT * FROM salary_history WHERE employee_id=? ORDER BY effective_date DESC, id DESC', [req.params.employeeId]); res.json(rows.map(r => ({...r, salary: decryptSecret(r.salary), notes: decryptSecret(r.notes)}))); });
app.post('/api/hr-info/:employeeId/salary-history', requireHr, async (req,res)=>{ const r = await run('INSERT INTO salary_history (employee_id,salary,effective_date,notes) VALUES (?,?,?,?)', [req.params.employeeId, encryptSecret(req.body.salary), req.body.effective_date, encryptSecret(req.body.notes)]); await auditLog(req, 'create_salary_history', 'salary_history', req.params.employeeId); const row = await get('SELECT * FROM salary_history WHERE id=?', [r.lastID]); res.json({...row, salary: decryptSecret(row.salary), notes: decryptSecret(row.notes)}); });

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
  if (isAdmin(req) || isHr(req)) return res.json(await all(`SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.title, e.manager_id, t.name AS team FROM employees e LEFT JOIN teams t ON e.team_id=t.id WHERE e.status='Active' ORDER BY e.manager_id`));
  const scoped = await scopedRows(req, 'employees');
  const ids = scoped.map(e => e.id);
  if (!ids.length) return res.json([]);
  res.json(await all(`SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.title, e.manager_id, t.name AS team FROM employees e LEFT JOIN teams t ON e.team_id=t.id WHERE e.status='Active' AND e.id IN (${placeholders(ids)}) ORDER BY e.manager_id`, ids));
});
app.get('/api/employees/:id/profile', requireAuth, async (req,res)=>{
  const id = req.params.id;
  if (!(isAdmin(req) || isHr(req))) {
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
