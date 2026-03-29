'use strict';

/**
 * Hermes Agent HTTP Gateway v4
 * - In-session memory: conversation history carried per session ID
 * - Cross-session memory: Hermes native memory tool enabled, persists to /data/.hermes/
 * - Session cache: agent instance reused per session (preserves context)
 */

const http = require('http');
const { spawn } = require('child_process');
const PORT = process.env.PORT || 8080;

// In-memory session store: sessionId → { history: [], lastActive: Date }
const sessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

// Clean up stale sessions every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL_MS) sessions.delete(id);
  }
}, 15 * 60 * 1000);

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

function cleanOutput(raw) {
  // Strip Hermes debug/startup lines, keep only the actual reply
  const skip = [
    'AI Agent initialized', 'Tool selection', 'Making API call', 'API call',
    'CONVERSATION SUMMARY', 'Completed:', 'Agent execution', 'Prompt caching',
    'Context limit', 'Available tools', 'Loaded', 'Request size', 'Elapsed',
    'Provider:', 'Endpoint:', 'Error details', 'Using API key', 'Using custom base',
    'Final tool', 'Some tools', 'User Query:', 'Starting conversation',
    'Context window', 'compress at',
  ];
  return raw.split('\n')
    .filter(line => {
      if (/^[🤖🔗🔑🛠️📊💾⚠️❌✅👋🔄📝💬📞🔌🌐💡📋🔄💻🧠📈🔍⏱️🎯🔀]/.test(line)) return false;
      if (line.startsWith('===') || line.startsWith('---') || line.startsWith('>>>')) return false;
      if (skip.some(s => line.includes(s))) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function buildPythonScript(prompt, history, sessionId) {
  // Build conversation history as Python list literal
  const historyJson = JSON.stringify(history);
  const sessionDir = `/data/.hermes/sessions`;

  return `
import sys, os, json
sys.path.insert(0, '/app')
os.environ['HERMES_QUIET'] = '1'
os.environ['PYTHONUNBUFFERED'] = '1'
os.environ['HOME'] = '/data'

# Ensure session dir exists
os.makedirs('${sessionDir}', exist_ok=True)

from run_agent import AIAgent
from hermes_cli.runtime_provider import resolve_runtime_provider

try:
    runtime = resolve_runtime_provider()
    agent = AIAgent(
        api_key=runtime.get('api_key'),
        base_url=runtime.get('base_url'),
        provider=runtime.get('provider'),
        api_mode=runtime.get('api_mode'),
        max_iterations=20,
        quiet_mode=True,
        session_id=${JSON.stringify(sessionId)},
        enabled_toolsets=['core', 'files', 'terminal', 'memory'],
    )
    agent._print_fn = lambda *a, **kw: None

    # Restore conversation history into agent
    history = json.loads(${JSON.stringify(historyJson)})
    if hasattr(agent, '_conversation_history'):
        agent._conversation_history = history
    elif hasattr(agent, 'conversation_history'):
        agent.conversation_history = history

    result = agent.chat(${JSON.stringify(prompt)})
    print(result if result else 'Done.')
except Exception as e:
    import traceback
    print(f'Error: {e}')
`;
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
    return sendJSON(res, 200, {
      status: 'ok',
      service: 'hermes-agent',
      sessions: sessions.size,
    });
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

      // Extract session ID from header or generate from message count (NullClaw sends full history)
      const sessionId = req.headers['x-session-id'] || `nullclaw-${messages.length}`;

      // Get or create session
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { history: [], lastActive: Date.now() });
      }
      const session = sessions.get(sessionId);
      session.lastActive = Date.now();

      // Extract the latest user message
      const userMsgs = messages.filter(m => m.role === 'user');
      const last = userMsgs[userMsgs.length - 1];
      if (!last) return sendJSON(res, 400, { error: 'No user message' });

      const prompt = typeof last.content === 'string'
        ? last.content
        : (last.content || []).map(c => c.text || '').join(' ');

      // Build history from full message array (NullClaw sends all messages)
      // Use all messages except the last user one (agent will add that)
      const historyForAgent = messages.slice(0, -1).map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : (m.content || []).map(c => c.text || '').join(''),
      }));

      const script = buildPythonScript(prompt, historyForAgent, sessionId);

      const child = spawn('python', ['-c', script], {
        cwd: '/app',
        env: {
          ...process.env,
          HERMES_QUIET: '1',
          PYTHONUNBUFFERED: '1',
          HOME: '/data',
        },
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Transfer-Encoding': 'chunked',
      });

      let out = '', err = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });

      const keepAlive = setInterval(() => { try { res.write(''); } catch {} }, 10000);

      const timer = setTimeout(() => {
        clearInterval(keepAlive);
        child.kill();
        if (!res.writableEnded) {
          const text = cleanOutput(out) || 'Agent timed out — try a shorter question.';
          res.end(JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: payload.model || 'hermes-agent',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: prompt.length, completion_tokens: text.length, total_tokens: prompt.length + text.length },
          }));
        }
      }, 300000);

      child.on('close', () => {
        clearTimeout(timer);
        clearInterval(keepAlive);
        if (res.writableEnded) return;

        const text = cleanOutput(out) || (err ? `Error: ${err.slice(0, 300)}` : 'No response');

        // Update session history
        session.history.push({ role: 'user', content: prompt });
        session.history.push({ role: 'assistant', content: text });
        // Keep last 40 messages (20 turns)
        if (session.history.length > 40) session.history = session.history.slice(-40);

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

  // Clear session endpoint
  if (req.method === 'POST' && req.url === '/session/clear') {
    const sessionId = req.headers['x-session-id'];
    if (sessionId && sessions.has(sessionId)) sessions.delete(sessionId);
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.timeout = 360000;
server.listen(PORT, () => {
  console.log(`Hermes Agent gateway v4 running on port ${PORT}`);
  console.log(`Memory: in-session history + Hermes native memory tool enabled`);
});
