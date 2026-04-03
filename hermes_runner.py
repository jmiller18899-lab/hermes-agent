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

def read_shared_memory(limit=8):
    """Fetch recent entries from the shared agent memory store."""
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
    """Write Hermes response summary to shared memory so ClawAgent can see it."""
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
        with urllib.request.urlopen(req, timeout=5) as resp:
            pass
    except Exception:
        pass

# Build system context including shared memory
shared_memory = read_shared_memory()
memory_context = ""
if shared_memory:
    memory_context = f"\n\n## Shared Agent Memory (recent work by ClawAgent & Hermes)\n{shared_memory}\n"

try:
    from run_agent import AIAgent
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
        enabled_toolsets=['core', 'files', 'terminal', 'memory'],
    )
    agent._print_fn = lambda *a, **kw: None

    # Inject shared memory into system prompt if available
    if memory_context and hasattr(agent, 'system_prompt'):
        agent.system_prompt = (agent.system_prompt or '') + memory_context
    elif memory_context and hasattr(agent, '_system_prompt'):
        agent._system_prompt = (agent._system_prompt or '') + memory_context

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

    # Write result to shared memory so ClawAgent can see it
    write_shared_memory(text[:500], task=args.prompt[:100])

    with open(args.outfile, 'w') as f:
        f.write(text)

except Exception as exc:
    with open(args.outfile, 'w') as f:
        f.write('Error: ' + str(exc))
