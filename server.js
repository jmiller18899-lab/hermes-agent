'use strict';

const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // Health check
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJSON(res, 200, { status: 'ok', service: 'hermes-agent' });
  }

  // Chat completions
  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/api/chat')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) {
        return sendJSON(res, 400, { error: 'Invalid JSON' });
      }

      const messages = payload.messages || [];
      const userMsgs = messages.filter(m => m.role === 'user');
      const last = userMsgs[userMsgs.length - 1];
      if (!last) return sendJSON(res, 400, { error: 'No user message' });

      const prompt = typeof last.content === 'string'
        ? last.content
        : (last.content || []).map(c => c.text || '').join(' ');

      const systemMsg = messages.find(m => m.role === 'system');
      const args = ['run_agent.py', '--message', prompt, '--no-interactive'];
      if (systemMsg) args.push('--system', systemMsg.content);

      const child = spawn('python', args, {
        cwd: '/app',
        env: { ...process.env, HERMES_QUIET: '1', PYTHONUNBUFFERED: '1' },
      });

      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });

      const timer = setTimeout(() => {
        child.kill();
        if (!res.headersSent) sendJSON(res, 504, { error: 'Agent timed out' });
      }, 90000);

      child.on('close', () => {
        clearTimeout(timer);
        if (res.headersSent) return;
        const text = out.replace(/\x1b\[[0-9;]*[mA-Za-z]/g, '').trim()
          || (err ? `Error: ${err.slice(0, 200)}` : 'No response');
        sendJSON(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: payload.model || 'hermes-agent',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: prompt.length, completion_tokens: text.length, total_tokens: prompt.length + text.length },
        });
      });
    });
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Hermes Agent gateway running on port ${PORT}`);
});
