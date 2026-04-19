import sys, os, json as _json, urllib.request
sys.path.insert(0, '/opt/hermes')
os.environ['HERMES_QUIET'] = '1'
os.environ['HOME'] = '/data'
os.makedirs('/data/.hermes', exist_ok=True)

import argparse
p = argparse.ArgumentParser()
p.add_argument('outfile')
p.add_argument('prompt')
p.add_argument('--history', default='[]')
args = p.parse_args()

MEMORY_BASE = os.environ.get(
    'NULLCLAW_BACKEND',
    'https://nullclaw-backend-production.up.railway.app'
).rstrip('/')

# OpenRouter Gemma config
OPENROUTER_KEY = os.environ.get('OPENROUTER_API_KEY', '')
# Use free Gemma 3 27B on OpenRouter
GEMMA_MODEL = os.environ.get('HERMES_MODEL', 'google/gemma-3-12b-it:free')

def read_shared_memory(limit=8):
    try:
        url = f"{MEMORY_BASE}/api/memory/read?limit={limit}"
        req = urllib.request.Request(url, headers={'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = _json.loads(resp.read())
        entries = data.get('entries', [])
        if not entries:
            return None
        lines = []
        for e in entries:
            ts = e.get('ts', '')[:19].replace('T', ' ')
            lines.append(f"[{ts}] {e['agent']}: {e['summary'][:300]}")
            if e.get('task'):
                lines.append(f"  Task: {e['task'][:100]}")
        return '\n'.join(lines)
    except Exception:
        return None

def write_shared_memory(summary, task=''):
    try:
        payload = _json.dumps({'agent': 'Hermes', 'task': task, 'summary': summary[:500]}).encode()
        req = urllib.request.Request(
            f"{MEMORY_BASE}/api/memory/write",
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception:
        pass

shared_memory = read_shared_memory()
memory_context = ""
if shared_memory:
    memory_context = f"\n\n## Shared Agent Memory\n{shared_memory}\n"

try:
    from run_agent import AIAgent
    from hermes_cli.runtime_provider import resolve_runtime_provider

    # Override runtime to use OpenRouter with Gemma
    if OPENROUTER_KEY:
        runtime = {
            'api_key': OPENROUTER_KEY,
            'base_url': 'https://openrouter.ai/api/v1',
            'provider': 'openai',  # OpenRouter is OpenAI-compatible
            'api_mode': 'openai',
        }
        # Set model env var for hermes to pick up
        os.environ['LLM_MODEL'] = GEMMA_MODEL
        os.environ['LLM_BACKEND'] = 'openai'
        os.environ['LLM_API_KEY'] = OPENROUTER_KEY
        os.environ['LLM_BASE_URL'] = 'https://openrouter.ai/api/v1'
    else:
        runtime = resolve_runtime_provider()

    agent = AIAgent(
        api_key=runtime.get('api_key'),
        base_url=runtime.get('base_url', 'https://openrouter.ai/api/v1'),
        provider=runtime.get('provider', 'openai'),
        api_mode=runtime.get('api_mode', 'openai'),
        max_iterations=20,
        quiet_mode=False,
        max_tokens=4096,
        enabled_toolsets=['core', 'files', 'terminal', 'memory'],
    )
    agent._print_fn = lambda *a, **kw: None

    # Inject shared memory into system prompt
    if memory_context:
        for attr in ['system_prompt', '_system_prompt', 'system']:
            if hasattr(agent, attr):
                setattr(agent, attr, (getattr(agent, attr) or '') + memory_context)
                break

    # Restore conversation history
    try:
        hist = _json.loads(args.history)
        for attr in ['_conversation_history', 'conversation_history', 'messages']:
            if hasattr(agent, attr):
                setattr(agent, attr, hist)
                break
    except Exception:
        pass

    result = agent.run_conversation(args.prompt)
    if isinstance(result, dict):
        text = result.get('final_response') or result.get('response') or repr(result)
    else:
        text = str(result) if result else '(no response)'

    text = text.strip()
    write_shared_memory(text[:500], task=args.prompt[:100])

    with open(args.outfile, 'w') as f:
        f.write(text)

except Exception as exc:
    with open(args.outfile, 'w') as f:
        f.write('Error: ' + str(exc))
