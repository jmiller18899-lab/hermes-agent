import sys, os, json as _json, urllib.request
# Try multiple possible install locations
for _p in ['/data/.hermes/hermes-agent', '/opt/hermes', os.path.dirname(os.path.abspath(__file__))]:
    if _p not in sys.path: sys.path.insert(0, _p)
os.environ['HERMES_QUIET'] = '1'
os.environ['HOME'] = '/data'
os.makedirs('/data/.hermes', exist_ok=True)

import argparse
p = argparse.ArgumentParser()
p.add_argument('outfile')
p.add_argument('prompt')
p.add_argument('--history', default='', help='Path to JSON file containing conversation history')
args = p.parse_args()

MEMORY_BASE = os.environ.get(
    'NULLCLAW_BACKEND',
    'https://nullclaw-backend-production.up.railway.app'
).rstrip('/')

OPENROUTER_KEY = os.environ.get('OPENROUTER_API_KEY', '')
GEMMA_MODEL = os.environ.get('HERMES_MODEL', 'google/gemma-3-12b-it:free')

def read_shared_memory(limit=5):
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
            lines.append(f"[{ts}] {e['agent']}: {e['summary'][:200]}")
        return '\n'.join(lines)
    except Exception:
        return None

def write_shared_memory(summary, task=''):
    try:
        payload = _json.dumps({
            'agent': 'Hermes',
            'task': task,
            'summary': summary[:500]
        }).encode()
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

# Load conversation history from file (passed by server.js)
conversation_history = []
if args.history and os.path.exists(args.history):
    try:
        with open(args.history) as f:
            conversation_history = _json.load(f)
    except Exception as e:
        pass

# Build system context
shared_memory = read_shared_memory()
system_additions = []
if shared_memory:
    system_additions.append(f"## Shared Agent Memory\n{shared_memory}")

try:
    from run_agent import AIAgent
    from hermes_cli.runtime_provider import resolve_runtime_provider

    # Configure OpenRouter with Gemma if key available
    if OPENROUTER_KEY:
        os.environ['LLM_MODEL'] = GEMMA_MODEL
        os.environ['LLM_BACKEND'] = 'openai'
        os.environ['LLM_API_KEY'] = OPENROUTER_KEY
        os.environ['LLM_BASE_URL'] = 'https://openrouter.ai/api/v1'
        runtime = {
            'api_key': OPENROUTER_KEY,
            'base_url': 'https://openrouter.ai/api/v1',
            'provider': 'openai',
            'api_mode': 'openai',
        }
    else:
        runtime = resolve_runtime_provider()

    enabled_toolsets = os.environ.get('HERMES_ENABLED_TOOLSETS', 'hermes-api-server')

    agent = AIAgent(
        api_key=runtime.get('api_key'),
        base_url=runtime.get('base_url', 'https://openrouter.ai/api/v1'),
        provider=runtime.get('provider', 'openai'),
        api_mode=runtime.get('api_mode', 'openai'),
        max_iterations=20,
        quiet_mode=False,
        max_tokens=4096,
        enabled_toolsets=[t.strip() for t in enabled_toolsets.split(',') if t.strip()],
    )
    agent._print_fn = lambda *a, **kw: None

    # Inject system additions
    if system_additions:
        extra = '\n\n' + '\n\n'.join(system_additions)
        for attr in ['system_prompt', '_system_prompt', 'system']:
            if hasattr(agent, attr):
                setattr(agent, attr, (getattr(agent, attr) or '') + extra)
                break

    # ── KEY FIX: Restore full conversation history ──────────────
    # Try multiple attribute names that different Hermes versions use
    if conversation_history:
        restored = False
        for attr in ['_conversation_history', 'conversation_history', 'messages', 'history']:
            if hasattr(agent, attr):
                setattr(agent, attr, conversation_history)
                restored = True
                break
        
        # Also try via the chat session if available
        if not restored and hasattr(agent, '_chat_session'):
            try:
                agent._chat_session.history = conversation_history
                restored = True
            except Exception:
                pass

        # Last resort: prepend history as a formatted system message
        if not restored:
            history_text = '\n'.join(
                f"{m['role'].upper()}: {m['content'][:300]}"
                for m in conversation_history[-10:]
                if m.get('role') != 'system'
            )
            if history_text:
                for attr in ['system_prompt', '_system_prompt', 'system']:
                    if hasattr(agent, attr):
                        existing = getattr(agent, attr) or ''
                        setattr(agent, attr, existing + f"\n\n## Recent Conversation History\n{history_text}")
                        break

    result = agent.run_conversation(args.prompt)

    if isinstance(result, dict):
        text = result.get('final_response') or result.get('response') or ''
        if not text:
            # Try other keys
            for key in ['output', 'answer', 'reply', 'text', 'content']:
                if result.get(key):
                    text = result[key]
                    break
        if not text:
            text = repr(result)
    else:
        text = str(result) if result else ''

    text = text.strip()

    # Write to shared memory
    if text and not text.startswith('Error:'):
        write_shared_memory(text[:500], task=args.prompt[:100])

    with open(args.outfile, 'w') as f:
        f.write(text if text else '(no response)')

except Exception as exc:
    import traceback
    err = f"Error: {exc}"
    with open(args.outfile, 'w') as f:
        f.write(err)
