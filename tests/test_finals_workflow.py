import contextlib
import io
import json
import os
from pathlib import Path
import textwrap
import unittest
from unittest.mock import patch
import urllib.error

workflow = (Path(__file__).parents[1] / '.github/workflows/finals.yml').read_text()
script = textwrap.dedent(workflow.split('        run: |\n', 1)[1])

class Response:
    def __init__(self, data): self.data = data
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self): return json.dumps(self.data).encode()

def execute(response):
    output = io.StringIO()
    with patch.dict(os.environ, {'FINAL_SYNC_KEY': 'test-secret'}), patch('urllib.request.urlopen', side_effect=response) as request, contextlib.redirect_stdout(output):
        try:
            exec(compile(script, 'workflow', 'exec'), {})
            exit_message = None
        except SystemExit as error:
            exit_message = str(error)
    return output.getvalue(), exit_message, request.call_count

class WorkflowTests(unittest.TestCase):
    def test_success_and_pending_backward_compatible(self):
        out, err, calls = execute([Response({'saved': 1, 'pending': 3, 'errors': []})])
        self.assertEqual(json.loads(out), {'pending': 3, 'saved': 1})
        self.assertIsNone(err)
        self.assertEqual(calls, 1)

    def test_safe_diagnostics_and_unknown_error(self):
        data = {'errors': ['secret'], 'diagnostics': [
            {'category': 'unknown', 'code': 'unknown', 'retryable': True, 'gameId': 'espn-123', 'message': 'secret'},
            {'category': 'unknown', 'code': 'secret', 'retryable': True},
            {'category': 'unknown', 'code': 'unknown', 'retryable': True, 'gameId': 'secret'},
        ]}
        out, err, calls = execute([Response(data)])
        self.assertNotIn('secret', out + err)
        self.assertEqual(json.loads(out)['diagnostics'], [
            {'category': 'unknown', 'code': 'unknown', 'retryable': True, 'gameId': 'espn-123'},
            {'category': 'unknown', 'code': 'unknown', 'retryable': True},
        ])
        self.assertIn('reported errors', err)
        self.assertEqual(calls, 1)

    def test_timeout_and_http_do_not_repeat_uncertain_write(self):
        for failure in (TimeoutError(), urllib.error.HTTPError('https://example.com', 503, 'secret', {}, None)):
            out, err, calls = execute([failure])
            self.assertEqual(calls, 1)
            self.assertNotIn('secret', out + err)
            self.assertTrue(err)

if __name__ == '__main__': unittest.main()
