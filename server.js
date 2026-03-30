'use strict';
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PORT = process.env.PORT || 8080;

const sessions = new Map();
setInterval(() => {
  const cut = Date.now() - 3600000;
  for (const [k,v] of sessions) if (v.t < cut) sessions.delete(k);
}, 900000);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-ic-url,x-session-id');
}

function reply(content, model) {
  return JSON.stringify({
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now()/1000),
    model: model || 'hermes-agent',
    choices: [{index:0, message:{role:'assistant', content}, finish_reason:'stop'}],
    usage: {prompt_tokens:0, completion_tokens:content.length, total_tokens:content.length}
  });
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  if (req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({status:'ok', service:'hermes-agent', sessions:sessions.size}));
  }

  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/api/chat')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'bad json'})); }

      const messages = payload.messages || [];
      const userMsgs = messages.filter(m => m.role === 'user');
      const last = userMsgs[userMsgs.length-1];
      if (!last) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'no user message'})); }

      const prompt = typeof last.content === 'string' ? last.content
        : (last.content||[]).map(c => c.text||'').join(' ');

      const sid = req.headers['x-session-id'] || ('s'+messages.length);
      if (!sessions.has(sid)) sessions.set(sid, {h:[], t:Date.now()});
      const sess = sessions.get(sid);
      sess.t = Date.now();

      const outFile = path.join(os.tmpdir(), 'hr_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.txt');

      // Spawn the separate python runner script — no escape issues
      const child = spawn('python', ['/app/hermes_runner.py', outFile, prompt], {
        cwd: '/app',
        env: { ...process.env, HERMES_QUIET:'1', HOME:'/data', PYTHONUNBUFFERED:'1' }
      });

      res.writeHead(200, {'Content-Type':'application/json','Transfer-Encoding':'chunked'});
      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      const ka = setInterval(() => { try { res.write(''); } catch {} }, 10000);

      const timer = setTimeout(() => {
        clearInterval(ka);
        child.kill();
        if (res.writableEnded) return;
        let text = 'Timed out after 5 min.';
        try { if (fs.existsSync(outFile)) { text = fs.readFileSync(outFile,'utf8').trim() || text; fs.unlinkSync(outFile); } } catch {}
        res.end(reply(text, payload.model));
      }, 300000);

      child.on('close', () => {
        clearTimeout(timer);
        clearInterval(ka);
        if (res.writableEnded) return;
        let text = '';
        try {
          if (fs.existsSync(outFile)) { text = fs.readFileSync(outFile,'utf8').trim(); fs.unlinkSync(outFile); }
        } catch {}
        if (!text) text = stderr ? 'Error: '+stderr.slice(0,300) : '(no response)';
        sess.h.push({role:'user',content:prompt},{role:'assistant',content:text});
        if (sess.h.length > 40) sess.h = sess.h.slice(-40);
        res.end(reply(text, payload.model));
      });
    });
    return;
  }

  res.writeHead(404,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'not found'}));
});

server.timeout = 360000;
server.listen(PORT, () => console.log('Hermes gateway on port '+PORT));
