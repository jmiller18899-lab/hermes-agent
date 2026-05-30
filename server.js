'use strict';
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.HERMES_HOME || '/data';
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AUTO_SETUP_ON_DEPLOY = (process.env.HERMES_AUTO_SETUP_ON_DEPLOY || '1') !== '0';

const LISTEN_HOST = process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME
  ? '0.0.0.0'
  : (process.env.HERMES_INSECURE === '1' ? '0.0.0.0' : '127.0.0.1');

// ── ntfy notification helper ─────────────────────────────────────
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'hermes_private_9922';
const NTFY_BASE  = process.env.NTFY_BASE  || 'https://ntfy.sh';

function ntfyNotify(title, message, priority) {
  try {
    const body = Buffer.from(message || '');
    const opts = {
      hostname: new URL(NTFY_BASE).hostname,
      path: '/' + NTFY_TOPIC,
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': priority || 'default',
        'Content-Type': 'text/plain',
        'Content-Length': body.length
      }
    };
    const req = https.request(opts);
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

// ── Telemetry store ──────────────────────────────────────────────
const telemetry = {
  tasks_started:   0,
  tasks_completed: 0,
  tasks_failed:    0,
  tasks_timed_out: 0,
  total_tokens:    0,
  uptime_start:    Date.now()
};

// ── Task tracker ─────────────────────────────────────────────────
// task_id -> { id, status, prompt_preview, session_id, started, finished, error }
const taskMap = new Map();
const MAX_TASKS = 200; // keep last 200 tasks in memory

function createTask(sessionId, promptPreview) {
  const id = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const task = {
    id,
    status: 'running',
    session_id: sessionId,
    prompt_preview: (promptPreview || '').slice(0, 120),
    started: Date.now(),
    finished: null,
    error: null
  };
  taskMap.set(id, task);
  telemetry.tasks_started++;
  // Prune oldest if over limit
  if (taskMap.size > MAX_TASKS) {
    const oldest = taskMap.keys().next().value;
    taskMap.delete(oldest);
  }
  return task;
}

function completeTask(task, success, errorMsg) {
  task.finished = Date.now();
  task.duration_ms = task.finished - task.started;
  if (success) {
    task.status = 'completed';
    telemetry.tasks_completed++;
    ntfyNotify(
      '✅ Hermes Task Done',
      `Session: ${task.session_id}\nDuration: ${(task.duration_ms / 1000).toFixed(1)}s\nPrompt: ${task.prompt_preview}`,
      'default'
    );
  } else {
    task.status = task.status === 'timeout' ? 'timeout' : 'failed';
    task.error = errorMsg || 'Unknown error';
    if (task.status === 'timeout') {
      telemetry.tasks_timed_out++;
      ntfyNotify(
        '⏱️ Hermes Task Timed Out',
        `Session: ${task.session_id}\nPrompt: ${task.prompt_preview}`,
        'high'
      );
    } else {
      telemetry.tasks_failed++;
      ntfyNotify(
        '❌ Hermes Task Failed',
        `Session: ${task.session_id}\nError: ${(errorMsg || '').slice(0, 200)}\nPrompt: ${task.prompt_preview}`,
        'high'
      );
    }
  }
}

// ── Python binary resolution ─────────────────────────────────────
function resolvePythonBin() {
  const candidates = [
    process.env.PYTHON_BIN,
    '/usr/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'pipe' });
      console.log(`[python] Resolved python binary: ${candidate}`);
      return candidate;
    } catch (_) {}
  }
  console.warn('[python] Warning: no python3 binary found in any candidate path');
  return 'python3';
}

const PYTHON_BIN = resolvePythonBin();

// ── Self-Improve Policy ──────────────────────────────────────────
const SI_MODE        = (process.env.SELF_IMPROVE_MODE || 'off').toLowerCase();
const SI_ALLOWED_RAW = process.env.SELF_IMPROVE_ALLOWED_REPOS || '';
const SI_ALLOWED     = SI_ALLOWED_RAW.split(',').map(r => r.trim()).filter(Boolean);
const SI_BRANCH_PFX  = process.env.SELF_IMPROVE_BRANCH_PREFIX || 'autofix/';
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN || '';
const SI_DISPATCH_SEC = process.env.SELF_IMPROVE_DISPATCH_SECRET || '';
const SI_VALID_MODES = ['on', 'propose', 'autopr'];

function getSIPolicy() {
  const blockers = [];
  if (!SI_VALID_MODES.includes(SI_MODE)) blockers.push('SELF_IMPROVE_MODE');
  if (SI_ALLOWED.length === 0) blockers.push('SELF_IMPROVE_ALLOWED_REPOS');
  return {
    mode: SI_MODE,
    write_policy: blockers.length === 0 ? 'allowed' : 'blocked',
    policy_blockers: blockers,
    repos_configured: SI_ALLOWED.length > 0,
    repos: SI_ALLOWED,
    branch_prefix: SI_BRANCH_PFX,
    token_present: GITHUB_TOKEN.length > 0,
    dispatch_secret_required: SI_DISPATCH_SEC.length > 0
  };
}

// GitHub API helper
function githubRequest(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'hermes-agent/0.16.0',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function siPushFile({ repo, filePath, content, message, baseBranch }) {
  const branch = SI_BRANCH_PFX + 'patch-' + Date.now();
  const [owner, repoName] = repo.split('/');
  const base = baseBranch || 'main';
  const refRes = await githubRequest('GET', `/repos/${owner}/${repoName}/git/ref/heads/${base}`, null, GITHUB_TOKEN);
  if (refRes.status !== 200) throw new Error(`Could not get ref for ${base}: ${refRes.status}`);
  const baseSha = refRes.body.object.sha;
  await githubRequest('POST', `/repos/${owner}/${repoName}/git/refs`, {
    ref: `refs/heads/${branch}`, sha: baseSha
  }, GITHUB_TOKEN);
  let existingSha;
  const fileRes = await githubRequest('GET', `/repos/${owner}/${repoName}/contents/${filePath}?ref=${branch}`, null, GITHUB_TOKEN);
  if (fileRes.status === 200) existingSha = fileRes.body.sha;
  const pushBody = {
    message: message || `self-improve: update ${filePath}`,
    content: Buffer.from(content).toString('base64'),
    branch
  };
  if (existingSha) pushBody.sha = existingSha;
  const pushRes = await githubRequest('PUT', `/repos/${owner}/${repoName}/contents/${filePath}`, pushBody, GITHUB_TOKEN);
  if (pushRes.status !== 200 && pushRes.status !== 201)
    throw new Error(`Push failed: ${pushRes.status} ${JSON.stringify(pushRes.body)}`);
  let pr = null;
  if (SI_MODE === 'propose' || SI_MODE === 'autopr') {
    const prRes = await githubRequest('POST', `/repos/${owner}/${repoName}/pulls`, {
      title: message || `self-improve: update ${filePath}`,
      head: branch, base,
      body: `Auto-generated by hermes-agent self-improve (mode: ${SI_MODE})\n\nFile: \`${filePath}\``
    }, GITHUB_TOKEN);
    if (prRes.status === 201) pr = { number: prRes.body.number, url: prRes.body.html_url };
  }
  return { branch, repo, file: filePath, commit: pushRes.body.commit?.sha, pr };
}

// ── Persistent session store ─────────────────────────────────────
let sessions = new Map();

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      sessions = new Map(Object.entries(raw));
      console.log(`[memory] Loaded ${sessions.size} sessions from disk`);
    }
  } catch (e) {
    console.error('[memory] Failed to load sessions:', e.message);
  }
}

function saveSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [k, v] of sessions) obj[k] = v;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.error('[memory] Failed to save sessions:', e.message);
  }
}

loadSessions();

function runDeploySetupOnce() {
  if (!AUTO_SETUP_ON_DEPLOY) return;
  try {
    const child = spawn('hermes', ['setup', '--non-interactive', '--deploy'], {
      env: { ...process.env, HERMES_HOME: DATA_DIR, HOME: DATA_DIR, HERMES_QUIET: '1' },
      stdio: 'pipe'
    });
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        console.warn('[setup] hermes binary not found on PATH — skipping deploy bootstrap');
      } else {
        console.warn('[setup] Deploy bootstrap spawn error:', e.message);
      }
    });
    child.stdout.on('data', (d) => process.stdout.write(`[setup] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[setup] ${d}`));
    child.on('close', (code) => {
      if (code === 0) console.log('[setup] Deployment bootstrap completed');
      else if (code !== null) console.warn(`[setup] Deployment bootstrap exited with code ${code}`);
    });
  } catch (e) {
    console.warn('[setup] Failed to launch deployment bootstrap:', e.message);
  }
}

runDeploySetupOnce();

setInterval(() => {
  const cut = Date.now() - 7 * 24 * 3600000;
  for (const [k, v] of sessions) if (v.t < cut) sessions.delete(k);
  saveSessions();
}, 5 * 60 * 1000);

// ── Sliding context window ───────────────────────────────────────
function buildContextHistory(sessionHistory) {
  const KEEP_RECENT = 20;
  if (sessionHistory.length <= KEEP_RECENT) return sessionHistory;
  const older = sessionHistory.slice(0, sessionHistory.length - KEEP_RECENT);
  const recent = sessionHistory.slice(-KEEP_RECENT);
  const summaryLines = older.map(m => `${m.role}: ${m.content.slice(0, 150)}`).join('\n');
  return [
    { role: 'system', content: `[Earlier conversation summary]\n${summaryLines}\n[End summary — full recent messages follow]` },
    ...recent
  ];
}

// ── CORS helper ──────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-ic-url,x-session-id,x-session-name,x-model');
}

function redactUrl(s) {
  return s.replace(/https?:\/\/[^\s"']*/g, (u) => {
    try { return new URL(u).hostname; } catch { return '[url]'; }
  });
}

function jsonReply(content, model) {
  return JSON.stringify({
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'hermes-agent',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: content.length, total_tokens: content.length }
  });
}

const HERMES_MODELS = [
  'hermes-agent',
  'nous-hermes-2-mixtral-8x7b',
  'nous-hermes-2-solar-10.7b',
  'nous-hermes-2-yi-34b',
  'nous-hermes-3-llama-3.1-70b'
];

// ── Request handler ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  const url = req.url.split('?')[0];

  // Health
  if (req.method === 'GET' && (url === '/' || url === '/health' || url === '/status')) {
    const sessionList = [];
    for (const [k, v] of sessions)
      sessionList.push({ id: k, name: v.name || k, messages: v.h.length, last: new Date(v.t).toISOString() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'hermes-agent', version: '0.16.0', python_bin: PYTHON_BIN, sessions: sessionList }));
  }

  // Stats / telemetry dashboard feed
  if (req.method === 'GET' && url === '/api/stats') {
    const running = [];
    const recent  = [];
    for (const [, t] of taskMap) {
      if (t.status === 'running') running.push(t);
      else recent.push(t);
    }
    recent.sort((a, b) => (b.finished || 0) - (a.finished || 0));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      telemetry,
      uptime_seconds: Math.floor((Date.now() - telemetry.uptime_start) / 1000),
      running_tasks: running,
      recent_tasks: recent.slice(0, 50),
      ntfy_topic: NTFY_TOPIC
    }));
  }

  // Tasks list
  if (req.method === 'GET' && url === '/api/tasks') {
    const tasks = [];
    for (const [, t] of taskMap) tasks.push(t);
    tasks.sort((a, b) => b.started - a.started);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ tasks: tasks.slice(0, 100), total: taskMap.size }));
  }

  // Single task lookup
  if (req.method === 'GET' && url.startsWith('/api/tasks/')) {
    const tid = url.replace('/api/tasks/', '');
    const task = taskMap.get(tid);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Task not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(task));
  }

  // Manual ntfy test
  if (req.method === 'POST' && url === '/api/notify/test') {
    ntfyNotify('🔔 Hermes Test', 'Notification system is working! Agent is alive.', 'default');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, topic: NTFY_TOPIC }));
  }

  // Models
  if (req.method === 'GET' && url === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: HERMES_MODELS.map(id => ({ id, object: 'model' })) }));
  }

  // Self-Improve: policy diagnostic
  if (req.method === 'GET' && url === '/self-improve/policy') {
    const policy = getSIPolicy();
    const repoToCheck = SI_ALLOWED[0];
    const repoPath = repoToCheck ? `/repos/${repoToCheck}` : '/user';
    githubRequest('GET', repoPath, null, GITHUB_TOKEN)
      .then(r => {
        policy.api_reachable = r.status === 200;
        policy.repo_accessible = repoToCheck ? r.status === 200 : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(policy));
      })
      .catch(() => {
        policy.api_reachable = false;
        policy.repo_accessible = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(policy));
      });
    return;
  }

  // Self-Improve: push file
  if (req.method === 'POST' && url === '/self-improve') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      const policy = getSIPolicy();
      if (policy.write_policy !== 'allowed') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Write policy blocked', blockers: policy.policy_blockers }));
      }
      if (!GITHUB_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'GITHUB_TOKEN not set' }));
      }
      let payload;
      try { payload = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      const { file, content, message, repo, base_branch } = payload;
      if (!file || !content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'file and content are required' }));
      }
      const targetRepo = repo || SI_ALLOWED[0];
      if (!SI_ALLOWED.includes(targetRepo)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Repo ${targetRepo} not in SELF_IMPROVE_ALLOWED_REPOS` }));
      }
      try {
        const result = await siPushFile({ repo: targetRepo, filePath: file, content, message, baseBranch: base_branch || 'main' });
        console.log(`[self-improve] mode=${SI_MODE} pushed ${file} to ${result.branch}${result.pr ? ' PR#' + result.pr.number : ''}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        console.error('[self-improve] Push failed:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Delete session
  if (req.method === 'DELETE' && url === '/session') {
    const sid = req.headers['x-session-id'];
    if (sid && sessions.has(sid)) { sessions.delete(sid); saveSessions(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Chat completions ── now with task lifecycle tracking
  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/api/chat')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      const userMsgs = (payload.messages || []).filter(m => m.role === 'user');
      const last = userMsgs[userMsgs.length - 1];
      if (!last) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No user message' }));
      }
      const prompt = typeof last.content === 'string'
        ? last.content
        : (last.content || []).map(c => c.text || '').join(' ');

      const sid = req.headers['x-session-id'] || 'default';
      const yolo = sid === 'yolo';
      const sessionName = req.headers['x-session-name'] || sid;
      const model = req.headers['x-model'] || payload.model || 'hermes-agent';

      // ── Create task record ────────────────────────────────────
      const task = createTask(sid, prompt);
      console.log(`[task] ${task.id} started | session=${sid} | prompt="${task.prompt_preview}"`);

      let sess;
      if (yolo) {
        sess = { h: [], t: Date.now(), name: 'yolo' };
      } else {
        if (!sessions.has(sid)) {
          sessions.set(sid, { h: [], t: Date.now(), name: sessionName });
          console.log(`[memory] New session: ${sid} (${sessionName})`);
        }
        sess = sessions.get(sid);
        sess.t = Date.now();
        if (sessionName !== sid) sess.name = sessionName;
      }

      const contextHistory = buildContextHistory(sess.h);
      const histFile = path.join(os.tmpdir(), 'hist_' + Date.now() + '.json');
      const outFile  = path.join(os.tmpdir(), 'out_'  + Date.now() + '_' + Math.random().toString(36).slice(2) + '.txt');

      try { fs.writeFileSync(histFile, JSON.stringify(contextHistory)); } catch (e) {
        console.error('[memory] Failed to write hist file:', e.message);
      }

      const runner = process.env.HERMES_RUNNER || '/data/.hermes/hermes-agent/hermes_runner.py';
      const cwd    = process.env.HERMES_DIR    || '/data/.hermes/hermes-agent';

      const child = spawn(PYTHON_BIN, [runner, outFile, prompt, '--history', histFile], {
        cwd, shell: false,
        env: { ...process.env, HERMES_QUIET: '1', HOME: '/data', PYTHONUNBUFFERED: '1', PYTHON_BIN }
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        clearInterval(ka);
        completeTask(task, false, `Spawn error: ${e.message}`);
        console.error(`[task] ${task.id} spawn error: ${e.message}`);
        if (!res.writableEnded) res.end(jsonReply(`Spawn error: ${e.message}`, model));
      });

      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });

      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      const ka = setInterval(() => { try { res.write(''); } catch {} }, 10000);

      const timer = setTimeout(() => {
        clearInterval(ka);
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
        task.status = 'timeout';
        completeTask(task, false, 'Timed out after 5 minutes');
        console.warn(`[task] ${task.id} TIMED OUT`);
        if (res.writableEnded) return;
        let text = 'Timed out after 5 minutes.';
        try { if (fs.existsSync(outFile)) text = fs.readFileSync(outFile, 'utf8').trim() || text; } catch {}
        try { fs.unlinkSync(outFile); } catch {}
        try { fs.unlinkSync(histFile); } catch {}
        res.end(jsonReply(text, model));
      }, 300000);

      child.on('close', () => {
        clearTimeout(timer);
        clearInterval(ka);
        if (res.writableEnded) return;
        let text = '';
        try { if (fs.existsSync(outFile)) text = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
        try { fs.unlinkSync(outFile); } catch {}
        try { fs.unlinkSync(histFile); } catch {}
        if (!text) {
          text = stderr ? 'Error: ' + stderr.slice(0, 600) : '(no response)';
          completeTask(task, false, stderr ? stderr.slice(0, 300) : 'No response from runner');
          console.error(`[task] ${task.id} failed | stderr: ${redactUrl(stderr.slice(0, 200))}`);
        } else {
          completeTask(task, true);
          console.log(`[task] ${task.id} completed in ${task.duration_ms}ms`);
        }
        if (!yolo) {
          sess.h.push({ role: 'user',      content: prompt });
          sess.h.push({ role: 'assistant', content: text });
          if (sess.h.length > 100) sess.h = sess.h.slice(-100);
          saveSessions();
        }
        res.end(jsonReply(text, model));
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.timeout = 360000;
server.listen(PORT, LISTEN_HOST, () => {
  const policy = getSIPolicy();
  console.log(`Hermes gateway v0.16.0 on ${LISTEN_HOST}:${PORT}`);
  console.log(`Python binary: ${PYTHON_BIN}`);
  console.log(`Sessions file: ${SESSIONS_FILE}`);
  console.log(`Self-improve: mode=${SI_MODE} | policy=${policy.write_policy} | repos=${SI_ALLOWED.join(',') || 'none'}`);
  console.log(`Notifications: ntfy topic=${NTFY_TOPIC}`);
  ntfyNotify('🚀 Hermes Online', `Gateway v0.16.0 started. Notifications active on topic: ${NTFY_TOPIC}`, 'low');
});
