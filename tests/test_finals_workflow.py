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

    def test_new_diagnostic_codes_are_preserved(self):
        for code in ('not_final', 'missing_boxscore', 'empty_boxscore', 'missing_stat_column', 'watch_score_pending'):
            out, err, calls = execute([Response({'errors': ['espn-1'], 'diagnostics': [{'category': 'source_pending', 'code': code, 'retryable': True, 'gameId': 'espn-1'}]})])
            self.assertEqual(json.loads(out)['diagnostics'][0]['code'], code)
            self.assertTrue(err)
            self.assertEqual(calls, 1)

    def test_game_and_watch_pending_counters_are_bounded_integers(self):
        out, err, calls = execute([Response({
            'gamePending': 0, 'watchPending': 3, 'errors': [],
        })])
        self.assertEqual(json.loads(out), {'gamePending': 0, 'watchPending': 3})
        self.assertIsNone(err)
        self.assertEqual(calls, 1)
        for invalid in (True, False, '3', -1, 1000001):
            out, err, calls = execute([Response({
                'gamePending': invalid, 'watchPending': invalid, 'errors': [],
            })])
            self.assertNotIn('gamePending', json.loads(out))
            self.assertNotIn('watchPending', json.loads(out))
            self.assertIsNone(err)
            self.assertEqual(calls, 1)

    def test_watch_diagnostic_and_repair_are_allowlisted(self):
        out, err, calls = execute([Response({'errors': [], 'diagnostics': [
            {'category': 'source_pending', 'code': 'watch_pbp_score_mismatch', 'retryable': True, 'gameId': 'espn-123', 'repair': 'rejected'},
            {'category': 'internal_error', 'code': 'watch_internal_error', 'retryable': True, 'repair': 'secret'},
        ]})])
        diagnostics = json.loads(out)['diagnostics']
        self.assertEqual(diagnostics[0]['repair'], 'rejected')
        self.assertNotIn('repair', diagnostics[1])
        self.assertNotIn('secret', out)
        self.assertIsNone(err)
        self.assertEqual(calls, 1)

    def test_every_watch_reason_is_emitted(self):
        reasons = ('missing_game', 'lease_busy', 'reason_unknown_legacy',
                   'performance_too_few', 'performance_minutes', 'performance_overall',
                   'performance_stats', 'invalid_final_score', 'performance_invalid',
                   'pbp_missing_events', 'pbp_start_incomplete', 'pbp_final_period_missing',
                   'pbp_end_incomplete', 'pbp_period_missing', 'pbp_score_mismatch',
                   'pbp_event_gap', 'pbp_unresolved', 'pbp_uncertainty')
        for reason in reasons:
            item = {'category': 'source_pending', 'code': 'watch_' + reason,
                    'retryable': True, 'gameId': 'espn-123', 'repair': 'not_attempted'}
            out, err, calls = execute([Response({'errors': [], 'diagnostics': [item]})])
            self.assertEqual(json.loads(out)['diagnostics'], [item])
            self.assertIsNone(err)
            self.assertEqual(calls, 1)

    def test_timeout_and_http_do_not_repeat_uncertain_write(self):
        for failure in (TimeoutError(), urllib.error.HTTPError('https://example.com', 503, 'secret', {}, None)):
            out, err, calls = execute([failure])
            self.assertEqual(calls, 1)
            self.assertNotIn('secret', out + err)
            self.assertTrue(err)

if __name__ == '__main__': unittest.main()
