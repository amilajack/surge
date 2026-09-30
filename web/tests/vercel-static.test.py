"""Versioned Vercel staging layout; no network or Git history needed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

scripts = Path(__file__).parents[1] / 'scripts'
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, scripts / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
packaging = load('packaging', 'package-static.py')
vercel = load('vercel_static', 'vercel-static.py')


class VercelStageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        build = self.root / 'build'
        build.mkdir()
        for name, content in {'surge-xt-browser.html': '<html><head><title>t</title></head><body><script src="surge-xt-browser.js"></script></body></html>',
                              'surge-xt-browser.js': 'wasm startup', 'surge-xt-browser.wasm': 'wasm',
                              'surge-xt-browser.data': 'fonts', 'library.js': 'catalog'}.items():
            (build / name).write_text(content)
        (build / 'library/objects').mkdir(parents=True)
        objects = []
        for data in (b'factory patch', b'patch index'):
            sha = hashlib.sha256(data).hexdigest()
            (build / 'library/objects' / sha).write_bytes(data)
            objects.append({'path': data.decode(), 'url': 'objects/' + sha, 'size': len(data), 'sha256': sha})
        (build / 'library/manifest.json').write_text(json.dumps({'schema': 1, 'entries': [objects[0]], 'patchIndex': objects[1]}))
        self.package = packaging.package(build, self.root / 'dist', {'commit': 'test', 'dirty': True, 'correspondingSourceIncluded': False})
        self.objects = objects

    def test_application_is_served_from_an_immutable_versioned_path(self):
        stage = self.root / 'stage'
        with patch.object(vercel.subprocess, 'check_output', return_value=b''):
            vercel.stage_package(self.package, stage, '0' * 40)
        version = self.package.name
        self.assertEqual(json.loads((stage / 'factory-source.json').read_text()), {'commit': '0' * 40, 'version': version})
        app = stage / 'public/v' / version
        self.assertEqual((app / 'surge-xt-browser.js').read_text(), 'wasm startup')
        self.assertIn(f'<head><base href="/v/{version}/">', (stage / 'public/index.html').read_text())
        # Factory objects are restored at build time; only the patch index is uploaded.
        self.assertFalse((app / 'library' / self.objects[0]['url']).exists())
        self.assertTrue((app / 'library' / self.objects[1]['url']).exists())
        self.assertEqual((stage / '.vercelignore').read_text().splitlines()[:2],
                         [f'public/v/{version}/library/objects/*', f'!public/v/{version}/library/{self.objects[1]["url"]}'])
        headers = {rule['source']: {h['key']: h['value'] for h in rule['headers']}
                   for rule in json.loads((stage / 'vercel.json').read_text())['headers']}
        self.assertEqual(headers['/v/(.*)']['Cache-Control'], 'public, max-age=31536000, immutable')
        self.assertEqual(headers['/(.*)']['Cache-Control'], 'public, max-age=0, must-revalidate')
        self.assertEqual(headers['/(.*)']['Cross-Origin-Embedder-Policy'], 'require-corp')


if __name__ == '__main__':
    unittest.main()
