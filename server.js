'use strict';

/**
 * Hermes Agent HTTP Gateway v6
 * Writes result to a temp file to bypass quiet_mode stdout suppression.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8080;

// Session store: sessionId -> { history: [{role,content}], lastActive }
const sessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, s] of sessions) if (s.lastActive < cutoff) sessions.delete(id);
}, 900000);

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ic-url, x-session-id',
  });
  res.end(data);
}

function makeReply(content, model) {
  return {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'hermes-agent',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: content.length, total_tokens: content.length },
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ic-url, x-session-id',
    });
    return res.end();
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJSON(res, 200, { status: 'ok', service: 'hermes-agent', sessions: sessions.size });
  }

  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/api/chat')) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

      const messages = payload.messages || [];
      const userMsgs = messages.filter(m => m.role === 'user');
      const last = userMsgs[userMsgs.length - 1];
      if (!last) return sendJSON(res, 400, { error: 'No user message' });

      const prompt = typeof last.content === 'string'
        ? last.content
        : (last.content || []).map(c => c.text || '').join(' ');

      // Session history
      const sessionId = req.headers['x-session-id'] || ('s' + messages.length);
      if (!sessions.has(sessionId)) sessions.set(sessionId, { history: [], lastActive: Date.now() });
      const session = sessions.get(sessionId);
      session.lastActive = Date.now();

      const history = messages.slice(0, -1).map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : (m.content || []).map(c => c.text || '').join(''),
      }));

      // Write result to temp file — avoids quiet_mode stdout suppression
      const outFile = path.join(os.tmpdir(), 'hermes_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.txt');
      const historyFile = path.join(os.tmpdir(), 'hermes_hist_' + Date.now() + '.json');
      fs.writeFileSync(historyFile, JSON.stringify(history));

      const pyScript = `
import sys, os, json
sys.path.insert(0, '/app')
os.environ['HERMES_QUIET'] = '1'
os.environ['PYTHONUNBUFFERED'] = '1'
os.environ['HOME'] = '/data'
os.makedirs('/data/.hermes', exist_ok=True)

outfile = ${JSON.stringify(outFile)}
histfile = ${JSON.stringify(historyFile)}
prompt = ${JSON.stringify(prompt)}

try:
    import json as _json
    from run_agent import AIAgent
    from hermes_cli.runtime_provider import resolve_runtime_provider

    runtime = resolve_runtime_provider()
    agent = AIAgent(
        api_key=runtime.get('api_key'),
        base_url=runtime.get('base_url'),
        provider=runtime.get('provider'),
        api_mode=runtime.get('api_mode'),
        max_iterations=20,
        quiet_mode=True,
        enabled_toolsets=['core', 'files', 'terminal', 'memory'],
    )
    agent._print_fn = lambda *a, **kw: None

    # Restore history
    with open(histfile) as f:
        hist = _json.load(f)
    for attr in ['_conversation_history', 'conversation_history', 'messages']:
        if hasattr(agent, attr):
            setattr(agent, attr, hist)
            break

    result = agent.chat(prompt)
    text = result if (result and result.strip()) else '(no response)'
    with open(outfile, 'w') as f:
        f.write(text)
except Exception as e:
    import traceback
    with open(outfile, 'w') as f:
        f.write('Error: ' + str(e))
`;

      const child = spawn('python', ['-c', pyScript], {
        cwd: '/app',
        env: { ...process.env, HERMES_QUIET: '1', PYTHONUNBUFFERED: '1', HOME: '/data' },
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Transfer-Encoding': 'chunked',
      });

      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      const keepAlive = setInterval(() => { try { res.write(''); } catch {} }, 10000);

      const timer = setTimeout(() => {
        clearInterval(keepAlive);
        child.kill();
        if (!res.writableEnded) {
          let text = 'Agent timed out (5 min). Try a shorter request.';
          try { if (fs.existsSync(outFile)) text = fs.readFileSync(outFile, 'utf8').trim() || text; } catch {}
          res.end(JSON.stringify(makeReply(text, payload.model)));
        }
      }, 300000);

      child.on('close', () => {
        clearTimeout(timer);
        clearInterval(keepAlive);
        if (res.writableEnded) return;

        let text = '';
        try {
          if (fs.existsSync(outFile)) {
            text = fs.readFileSync(outFile, 'utf8').trim();
            fs.unlinkSync(outFile);
          }
        } catch {}
        try { fs.unlinkSync(historyFile); } catch {}

        if (!text) text = stderr ? 'Error: ' + stderr.slice(0, 300) : '(no response from agent)';

        // Update session
        session.history.push({ role: 'user', content: prompt });
        session.history.push({ role: 'assistant', content: text });
        if (session.history.length > 40) session.history = session.history.slice(-40);

        res.end(JSON.stringify(makeReply(text, payload.model)));
      });
    });
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.timeout = 360000;
server.listen(PORT, () => console.log('Hermes gateway v6 on port ' + PORT));
