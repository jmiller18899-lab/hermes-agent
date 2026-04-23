import sys, os, json as _json, urllib.request

# Try all possible install paths
for _p in [
    '/data/.hermes/hermes-agent',
    os.path.dirname(os.path.abspath(__file__)),
    '/opt/hermes',
]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

os.environ['HERMES_QUIET'] = '1'
os.environ['HOME'] = '/data'
os.makedirs('/data/.hermes', exist_ok=True)

import argparse
p = argparse.ArgumentParser()
p.add_argument('outfile')
p.add_argument('prompt')
p.add_argument('--history', default='', help='Path to JSON history file')
args = p.parse_args()

MEMORY_BASE = os.environ.get('NULLCLAW_BACKEND', 'https://nullclaw-backend-production.up.railway.app').rstrip('/')
OPENROUTER_KEY = os.environ.get('OPENROUTER_API_KEY', '')
GEMMA_MODEL = os.environ.get('HERMES_MODEL', 'google/gemma-4-26b-a4b-it:free')  # 262K context  # 128K context

def read_shared_memory(limit=5):
    try:
        url = f"{MEMORY_BASE}/api/memory/read?limit={limit}"
        req = urllib.request.Request(url, headers={'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = _json.loads(resp.read())
        entries = data.get('entries', [])
        if not entries: return None
        return '\n'.join(f"[{e.get('ts','')[:19]}] {e['agent']}: {e['summary'][:200]}" for e in entries)
    except Exception:
        return None

def write_shared_memory(summary, task=''):
    try:
        payload = _json.dumps({'agent': 'Hermes', 'task': task, 'summary': summary[:500]}).encode()
        req = urllib.request.Request(f"{MEMORY_BASE}/api/memory/write", data=payload,
            headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=5): pass
    except Exception:
        pass

# Load conversation history
conversation_history = []
if args.history and os.path.exists(args.history):
    try:
        with open(args.history) as f:
            conversation_history = _json.load(f)
    except Exception:
        pass

shared_memory = read_shared_memory()

try:
    from run_agent import AIAgent

    if OPENROUTER_KEY:
        os.environ['LLM_BACKEND'] = 'openai'
        os.environ['LLM_API_KEY'] = OPENROUTER_KEY
        os.environ['LLM_BASE_URL'] = 'https://openrouter.ai/api/v1'
        os.environ['LLM_MODEL'] = GEMMA_MODEL

        agent = AIAgent(
            api_key=OPENROUTER_KEY,
            base_url='https://openrouter.ai/api/v1',
            provider='openai',
            api_mode='openai',
            model=GEMMA_MODEL,
            max_iterations=20,
            quiet_mode=False,
            max_tokens=4096,
            enabled_toolsets=['core', 'files', 'terminal', 'memory'],
        )
    else:
        from hermes_cli.runtime_provider import resolve_runtime_provider
        runtime = resolve_runtime_provider()
        agent = AIAgent(
            api_key=runtime.get('api_key'),
            base_url=runtime.get('base_url'),
            provider=runtime.get('provider'),
            api_mode=runtime.get('api_mode'),
            max_iterations=20,
            quiet_mode=False,
            max_tokens=4096,
        )

    agent._print_fn = lambda *a, **kw: None

    # Inject shared memory into system prompt
    if shared_memory:
        extra = f'\n\n## Shared Agent Memory\n{shared_memory}'
        for attr in ['system_prompt', '_system_prompt', 'system']:
            if hasattr(agent, attr):
                setattr(agent, attr, (getattr(agent, attr) or '') + extra)
                break

    # Restore conversation history
    if conversation_history:
        for attr in ['_conversation_history', 'conversation_history', 'messages', 'history']:
            if hasattr(agent, attr):
                setattr(agent, attr, conversation_history)
                break

    result = agent.run_conversation(args.prompt)

    if isinstance(result, dict):
        text = result.get('final_response') or result.get('response') or ''
        if not text:
            for key in ['output', 'answer', 'reply', 'text', 'content']:
                if result.get(key):
                    text = result[key]
                    break
        if not text:
            text = repr(result)
    else:
        text = str(result) if result else ''

    text = text.strip()
    if text and not text.startswith('Error:'):
        write_shared_memory(text[:500], task=args.prompt[:100])

    with open(args.outfile, 'w') as f:
        f.write(text if text else '(no response)')

except Exception as exc:
    with open(args.outfile, 'w') as f:
        f.write('Error: ' + str(exc))
