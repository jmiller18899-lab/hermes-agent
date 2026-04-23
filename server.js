'use strict';
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.HERMES_HOME || '/data';
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AUTO_SETUP_ON_DEPLOY = (process.env.HERMES_AUTO_SETUP_ON_DEPLOY || '1') !== '0';

// ── Persistent session store ─────────────────────────────────────
// Loads from disk on startup, saves after every message
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

// Load on startup
loadSessions();

function runDeploySetupOnce() {
  if (!AUTO_SETUP_ON_DEPLOY) return;
  try {
    const child = spawn('hermes', ['setup', '--non-interactive', '--deploy'], {
      env: { ...process.env, HERMES_HOME: DATA_DIR, HOME: DATA_DIR, HERMES_QUIET: '1' },
      stdio: 'pipe'
    });
    child.stdout.on('data', (d) => process.stdout.write(`[setup] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[setup] ${d}`));
    child.on('close', (code) => {
      if (code === 0) {
        console.log('[setup] Deployment bootstrap completed');
      } else {
        console.warn(`[setup] Deployment bootstrap exited with code ${code}`);
      }
    });
  } catch (e) {
    console.warn('[setup] Failed to launch deployment bootstrap:', e.message);
  }
}

runDeploySetupOnce();

// Clean up sessions older than 7 days, save every 5 min
setInterval(() => {
  const cut = Date.now() - 7 * 24 * 3600000;
  for (const [k, v] of sessions) if (v.t < cut) sessions.delete(k);
  saveSessions();
}, 5 * 60 * 1000);

// ── Summarize old messages to keep context window manageable ─────
function buildContextHistory(sessionHistory) {
  // Keep last 20 messages in full
  // Summarize anything older into a single context block
  const KEEP_RECENT = 20;
  if (sessionHistory.length <= KEEP_RECENT) return sessionHistory;

  const older = sessionHistory.slice(0, sessionHistory.length - KEEP_RECENT);
  const recent = sessionHistory.slice(-KEEP_RECENT);

  // Build a plain text summary of older messages
  const summaryLines = older.map(m => `${m.role}: ${m.content.slice(0, 150)}`).join('\n');
  const summaryMsg = {
    role: 'system',
    content: `[Earlier conversation summary]\n${summaryLines}\n[End summary — full recent messages follow]`
  };

  return [summaryMsg, ...recent];
}

// ── CORS helper ──────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-ic-url,x-session-id,x-session-name');
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

// ── Request handler ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  const url = req.url.split('?')[0];

  // Health / session list
  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    const sessionList = [];
    for (const [k, v] of sessions) {
      sessionList.push({ id: k, name: v.name || k, messages: v.h.length, last: new Date(v.t).toISOString() });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'hermes-agent', sessions: sessionList }));
  }

  // Clear a specific session
  if (req.method === 'DELETE' && url === '/session') {
    const sid = req.headers['x-session-id'];
    if (sid && sessions.has(sid)) {
      sessions.delete(sid);
      saveSessions();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Chat completions
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

      const incomingMessages = payload.messages || [];
      const userMsgs = incomingMessages.filter(m => m.role === 'user');
      const last = userMsgs[userMsgs.length - 1];
      if (!last) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No user message' }));
      }

      const prompt = typeof last.content === 'string'
        ? last.content
        : (last.content || []).map(c => c.text || '').join(' ');

      // Session management
      const sid = req.headers['x-session-id'] || 'default';
      const sessionName = req.headers['x-session-name'] || sid;

      if (!sessions.has(sid)) {
        sessions.set(sid, { h: [], t: Date.now(), name: sessionName });
        console.log(`[memory] New session: ${sid} (${sessionName})`);
      }
      const sess = sessions.get(sid);
      sess.t = Date.now();
      if (sessionName !== sid) sess.name = sessionName;

      // Build context: server-side history (persistent) takes priority over payload messages
      // This is the key fix — we pass OUR stored history, not the truncated payload history
      const contextHistory = buildContextHistory(sess.h);

      console.log(`[memory] Session ${sid}: ${sess.h.length} stored messages, sending ${contextHistory.length} in context`);

      // Write history to a temp file for the Python runner
      const histFile = path.join(os.tmpdir(), 'hist_' + Date.now() + '.json');
      const outFile = path.join(os.tmpdir(), 'out_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.txt');

      try {
        fs.writeFileSync(histFile, JSON.stringify(contextHistory));
      } catch (e) {
        console.error('[memory] Failed to write hist file:', e.message);
      }

      const runner = process.env.HERMES_RUNNER || '/data/.hermes/hermes-agent/hermes_runner.py';
      const cwd = process.env.HERMES_DIR || '/data/.hermes/hermes-agent';

      const child = spawn('python3', [runner, outFile, prompt, '--history', histFile], {
        cwd,
        env: { ...process.env, HERMES_QUIET: '1', HOME: '/data', PYTHONUNBUFFERED: '1' }
      });

      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });

      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      const ka = setInterval(() => { try { res.write(''); } catch {} }, 10000);

      const timer = setTimeout(() => {
        clearInterval(ka);
        child.kill();
        if (res.writableEnded) return;
        let text = 'Timed out after 5 minutes.';
        try {
          if (fs.existsSync(outFile)) { text = fs.readFileSync(outFile, 'utf8').trim() || text; }
        } catch {}
        try { fs.unlinkSync(outFile); } catch {}
        try { fs.unlinkSync(histFile); } catch {}
        res.end(jsonReply(text, payload.model));
      }, 300000);

      child.on('close', () => {
        clearTimeout(timer);
        clearInterval(ka);
        if (res.writableEnded) return;

        let text = '';
        try {
          if (fs.existsSync(outFile)) { text = fs.readFileSync(outFile, 'utf8').trim(); }
        } catch {}
        try { fs.unlinkSync(outFile); } catch {}
        try { fs.unlinkSync(histFile); } catch {}

        if (!text) {
          text = stderr ? 'Error: ' + stderr.slice(0, 600) : '(no response)';
          if (stderr) console.error('[hermes] stderr:', stderr.slice(0, 400));
        }

        // Store full exchange in persistent session history
        sess.h.push({ role: 'user', content: prompt });
        sess.h.push({ role: 'assistant', content: text });

        // Keep max 100 messages (50 turns) in storage
        if (sess.h.length > 100) sess.h = sess.h.slice(-100);

        // Save to disk after every exchange
        saveSessions();

        console.log(`[memory] Session ${sid} now has ${sess.h.length} messages`);
        res.end(jsonReply(text, payload.model));
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.timeout = 360000;
server.listen(PORT, () => {
  console.log(`Hermes gateway v2 (persistent memory) on port ${PORT}`);
  console.log(`Sessions file: ${SESSIONS_FILE}`);
});
