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
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJSON(res, 200, { status: 'ok', service: 'hermes-agent' });
  }

  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/api/chat')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
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

      // Build a minimal Python script that calls hermes and exits fast
      const script = `
import sys
import os
sys.path.insert(0, '/app')
os.environ['HERMES_QUIET'] = '1'
os.environ['PYTHONUNBUFFERED'] = '1'

from run_agent import AIAgent
from hermes_cli.runtime_provider import resolve_runtime_provider

try:
    runtime = resolve_runtime_provider()
    agent = AIAgent(
        api_key=runtime.get('api_key'),
        base_url=runtime.get('base_url'),
        provider=runtime.get('provider'),
        api_mode=runtime.get('api_mode'),
        max_iterations=5,
        quiet_mode=True,
        enabled_toolsets=['core', 'files', 'terminal'],
    )
    agent._print_fn = lambda *a, **kw: None
    result = agent.chat(${JSON.stringify(prompt)})
    print(result if result else 'Done.')
except Exception as e:
    print(f'Error: {e}')
`;

      const child = spawn('python', ['-c', script], {
        cwd: '/app',
        env: { ...process.env, HERMES_QUIET: '1', PYTHONUNBUFFERED: '1' },
      });

      // Set headers immediately — keep connection alive while agent runs
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Transfer-Encoding': 'chunked',
      });

      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });

      // Send a keep-alive comment every 10s so the connection stays open
      const keepAlive = setInterval(() => {
        try { res.write(''); } catch {}
      }, 10000);

      const timer = setTimeout(() => {
        clearInterval(keepAlive);
        child.kill();
        if (!res.writableEnded) {
          const text = out.trim() || 'Agent timed out after 120s.';
          res.end(JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: payload.model || 'hermes-agent',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: prompt.length, completion_tokens: text.length, total_tokens: prompt.length + text.length },
          }));
        }
      }, 120000);

      child.on('close', () => {
        clearTimeout(timer);
        clearInterval(keepAlive);
        if (res.writableEnded) return;

        // Extract just the actual reply — strip the debug header lines
        let text = out;
        // Remove lines starting with emoji/debug markers
        const lines = text.split('\n');
        const replyLines = [];
        let foundReply = false;
        for (const line of lines) {
          // Skip hermes debug lines (start with emoji or ===)
          if (/^[🤖🔗🔑🛠️📊💾⚠️❌✅👋🔄📝💬📞🔌🌐💡📋👋]/.test(line)) continue;
          if (line.startsWith('===') || line.startsWith('---')) continue;
          if (line.includes('AI Agent initialized') || line.includes('Tool selection') || 
              line.includes('API call') || line.includes('Making API') ||
              line.includes('CONVERSATION SUMMARY') || line.includes('Completed:') ||
              line.includes('Messages:') || line.includes('Agent execution')) continue;
          replyLines.push(line);
        }
        text = replyLines.join('\n').trim() || out.trim() || (err ? `Error: ${err.slice(0, 300)}` : 'No response');

        res.end(JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: payload.model || 'hermes-agent',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: prompt.length, completion_tokens: text.length, total_tokens: prompt.length + text.length },
        }));
      });
    });
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.timeout = 180000; // 3 min server timeout
server.listen(PORT, () => {
  console.log(`Hermes Agent gateway running on port ${PORT}`);
});
