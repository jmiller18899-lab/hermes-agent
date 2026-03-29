'use strict';

const express = require('express');
const { spawn } = require('child_process');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// CORS — allow NullClaw and any frontend to call this
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'hermes-agent' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

/**
 * OpenAI-compatible chat completions endpoint.
 * Accepts: { model, messages: [{role, content}], stream? }
 * Returns: OpenAI-format response or SSE stream
 */
app.post('/v1/chat/completions', async (req, res) => {
  const { messages = [], stream = false, model } = req.body;

  // Extract the last user message as the prompt
  const userMessages = messages.filter(m => m.role === 'user');
  const lastUser = userMessages[userMessages.length - 1];
  if (!lastUser) {
    return res.status(400).json({ error: 'No user message found' });
  }

  const prompt = typeof lastUser.content === 'string'
    ? lastUser.content
    : lastUser.content.map(c => c.text || '').join(' ');

  // Build system prompt from messages
  const systemMsg = messages.find(m => m.role === 'system');
  const systemPrompt = systemMsg ? systemMsg.content : '';

  // Spawn hermes Python agent
  const args = ['run_agent.py', '--message', prompt, '--no-interactive'];
  if (systemPrompt) args.push('--system', systemPrompt);
  if (model) args.push('--model', model);

  const env = {
    ...process.env,
    HERMES_QUIET: '1',
    PYTHONUNBUFFERED: '1',
  };

  const child = spawn('python', args, { env, cwd: '/app' });

  let output = '';
  let errorOutput = '';

  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { errorOutput += d.toString(); });

  child.on('close', (code) => {
    // Clean up ANSI codes and control characters from output
    const cleaned = output
      .replace(/\x1b\[[0-9;]*m/g, '')   // ANSI colors
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // other escape sequences
      .trim();

    const responseText = cleaned || (code !== 0
      ? `Error running agent (exit ${code}): ${errorOutput.slice(0, 200)}`
      : 'No response');

    if (stream) {
      // SSE streaming format
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const chunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'hermes-agent',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: responseText },
          finish_reason: null,
        }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);

      const done = {
        ...chunk,
        choices: [{ ...chunk.choices[0], delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // Standard JSON response
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'hermes-agent',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: responseText },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: prompt.length,
          completion_tokens: responseText.length,
          total_tokens: prompt.length + responseText.length,
        },
      });
    }
  });

  // Timeout after 90s
  setTimeout(() => {
    if (!res.headersSent) {
      child.kill();
      res.status(504).json({ error: 'Agent timed out after 90s' });
    }
  }, 90000);
});

// Also support the IronClaw-style gateway endpoint NullClaw uses
app.post('/api/chat', (req, res) => {
  req.body.messages = req.body.messages || [{ role: 'user', content: req.body.message || '' }];
  req.url = '/v1/chat/completions';
  app._router.handle(req, res);
});

app.listen(PORT, () => {
  console.log(`Hermes Agent HTTP Gateway running on port ${PORT}`);
  console.log(`Endpoints: POST /v1/chat/completions, GET /health`);
});
