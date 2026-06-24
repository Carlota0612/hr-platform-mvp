const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3900 + Math.floor(Math.random() * 500);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-sec-test-'));
const env = {
  ...process.env,
  PORT: String(port),
  DATA_DIR: dataDir,
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'StrongPass123!',
  SESSION_SECRET: 'test-session-secret-with-enough-entropy',
  HR_ENCRYPTION_KEY: 'test-hr-encryption-key-with-enough-entropy'
};
const server = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let cookie = '';

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    server.stdout.on('data', data => {
      if (String(data).includes('HR platform running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.stderr.on('data', data => process.stderr.write(data));
    server.on('exit', code => reject(new Error(`Server exited early with ${code}`)));
  });
}
async function request(pathname, options = {}) {
  const headers = {...(options.headers || {})};
  if (cookie) headers.cookie = cookie;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://localhost:${port}${pathname}`, {...options, headers});
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return { response, body };
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
(async () => {
  try {
    await waitForServer();
    let result = await request('/api/login', { method:'POST', body: JSON.stringify({email:'admin@example.com', password:'StrongPass123!'}) });
    assert(result.response.ok, 'admin login failed');
    const token = result.body.user.csrfToken;

    result = await request('/api/users', { method:'POST', body: JSON.stringify({name:'No Token', email:'no-token@example.com', password:'StrongPass123!', roles:['user']}) });
    assert(result.response.status === 403, 'CSRF protection did not reject missing token');

    result = await request('/api/users', { method:'POST', headers:{'X-CSRF-Token':token}, body: JSON.stringify({name:'Combo', email:'combo@example.com', password:'StrongPass123!', roles:['admin','hr']}) });
    assert(result.response.ok, 'admin could not create combined admin/hr user');
    assert(result.body.role === 'admin,hr', 'combined roles were not saved');

    result = await request('/api/hr-info/2', { method:'PUT', headers:{'X-CSRF-Token':token}, body: JSON.stringify({salary:'123456', bonus:'1000', visa_status:'Valid', job_grade:'G7', birthday:'1990-01-01', salary_effective_date:'2026-06-24'}) });
    assert(result.response.ok, 'admin/hr could not update HR info');
    assert(String(result.body.salary) === '123456', 'HR info did not decrypt for authorized response');

    result = await request('/api/tasks', { method:'POST', headers:{'X-CSRF-Token':token}, body: JSON.stringify({title:'Security task', status:'Not started'}) });
    assert(result.response.ok, 'could not create test task');
    const taskId = result.body.id;
    result = await request(`/api/tasks/${taskId}/status`, { method:'PUT', headers:{'X-CSRF-Token':token}, body: JSON.stringify({status:'Done'}) });
    assert(result.response.ok && result.body.status === 'Done', 'kanban task status update failed');

    result = await request('/api/settings', { method:'PUT', headers:{'X-CSRF-Token':token}, body: JSON.stringify({taskStatuses:['Not started','In progress','Done','On hold','Blocked']}) });
    assert(result.response.ok, 'could not update task statuses');

    result = await request('/api/audit-logs');
    assert(result.response.ok && result.body.length > 0, 'audit logs not available');

    console.log('security smoke test passed');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(err => {
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
