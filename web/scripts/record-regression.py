#!/usr/bin/env python3
"""Run the full browser suite and record web/parity/browser-regression.json.

Hashes every spec and the tested binaries before and after the run, so the
record states whether anything changed while the suite was running.
"""
import hashlib, json, os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
WEB = ROOT / 'web'
BINARIES = ['build-web/web/surge-web.wasm', 'build-web/web/surge-xt-browser.wasm',
            'build-web/web/surge-juce-browser-check.wasm',
            'build-reference/src/surge-web/surge-engine-reference']

def hashes():
    files = sorted(str(p.relative_to(ROOT)) for p in (WEB / 'tests').rglob('*') if p.is_file()) + BINARIES
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            for name in files if (ROOT / name).is_file()}

def chrome_version():
    try:
        output = subprocess.run(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--version'],
                                capture_output=True, text=True, timeout=30).stdout
        return re.search(r'[\d.]+', output).group(0)
    except Exception:
        return 'unknown'

def main():
    scope = sys.argv[1] if len(sys.argv) > 1 else (
        'Existing automated browser regression suite; not complete migration, physical device, '
        'performance deadline or unreviewed portable-feature proof.')
    command = ['./node_modules/.bin/playwright', 'test', '--max-failures=5', '--reporter=line']
    before = hashes()
    started = time.time()
    run = subprocess.run(command, cwd=WEB, env={**os.environ, 'SURGE_TEST_SILENT_OUTPUT': '1'},
                         capture_output=True, text=True)
    minutes = round((time.time() - started) / 60, 1)
    after = hashes()
    output = run.stdout + run.stderr
    passed = int((re.findall(r'(\d+) passed', output) or [0])[-1])
    failed = int((re.findall(r'(\d+) failed', output) or [0])[-1])
    flaky = int((re.findall(r'(\d+) flaky', output) or [0])[-1])
    git = lambda *args: subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    record = {
        'schema': 1,
        'status': 'passed' if run.returncode == 0 and failed == 0 else 'failed',
        'scope': scope,
        'command': 'SURGE_TEST_SILENT_OUTPUT=1 ' + ' '.join(command),
        'workingDirectory': 'web',
        'chrome': chrome_version(),
        'testsPassed': passed,
        'testsFailed': failed,
        'testsFlaky': flaky,
        'reportedMinutes': minutes,
        'silentOutput': True,
        'worktreeDirty': bool(git('status', '--porcelain', '--', 'src', 'web', 'cmake')),
        'gitHead': git('rev-parse', 'HEAD'),
        'artifactHashesUnchangedAtCompletion': before == after,
        'files': before,
    }
    (WEB / 'parity' / 'browser-regression.json').write_text(json.dumps(record, indent=2) + '\n')
    print(output[-3000:])
    print(json.dumps({k: record[k] for k in ('status', 'testsPassed', 'testsFailed', 'testsFlaky',
                                              'reportedMinutes', 'artifactHashesUnchangedAtCompletion')}))
    return 0 if record['status'] == 'passed' else 1

if __name__ == '__main__':
    sys.exit(main())
