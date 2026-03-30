
import sys, os, json as _json
sys.path.insert(0, '/app')
os.environ['HERMES_QUIET'] = '1'
os.environ['HOME'] = '/data'
os.makedirs('/data/.hermes', exist_ok=True)

import argparse
p = argparse.ArgumentParser()
p.add_argument('outfile')
p.add_argument('prompt')
p.add_argument('--history', default='[]')
args = p.parse_args()

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
        enabled_toolsets=['core', 'files', 'terminal', 'memory'],
    )
    agent._print_fn = lambda *a, **kw: None
    result = agent.run_conversation(args.prompt)
    if isinstance(result, dict):
        text = result.get('final_response') or result.get('response') or repr(result)
    else:
        text = str(result) if result else '(no response)'
    with open(args.outfile, 'w') as f:
        f.write(text.strip())
except Exception as exc:
    with open(args.outfile, 'w') as f:
        f.write('Error: ' + str(exc))
