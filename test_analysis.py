"""Analysis API/worker tests; no neural model is loaded for these tests."""
import io
import json
import os
import subprocess
import time
import unittest
from unittest.mock import patch

from flask import Flask
from analysis import AnalysisManager, WINNING_MASKS, analysis_blueprint, validate_request


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.manager = AnalysisManager('fake-engine', lease_seconds=0.05)
        app = Flask(__name__)
        app.register_blueprint(analysis_blueprint(self.manager))
        self.client = app.test_client()

    def tearDown(self):
        self.manager.close()

    def test_validation(self):
        self.assertEqual(len(WINNING_MASKS), 76)
        self.assertEqual(validate_request({'moves': [0, 1], 'top': 16}), ([0, 1], 16))
        for data in (None, [], {}, {'moves': '0'}, {'moves': [True]}, {'moves': [16]},
                     {'moves': [-1]}, {'moves': [0.5]}, {'moves': [0] * 5},
                     {'moves': [], 'top': True}, {'moves': [], 'top': 17},
                     {'moves': [0, 4, 1, 5, 2, 6, 3, 7]}):
            with self.subTest(data=data):
                self.assertEqual(self.client.post('/api/analysis/start', json=data).status_code, 400)

    def test_missing_engine_and_unknown_job(self):
        self.assertEqual(self.client.post('/api/analysis/start', json={'moves': []}).status_code, 503)
        self.assertEqual(self.client.get('/api/analysis/not-a-job').status_code, 404)
        self.assertEqual(self.client.post('/api/analysis/not-a-job/stop').status_code, 200)

    def test_worker_protocol(self):
        update = {'type': 'iteration', 'depth': 2, 'moves': [{'move': 0, 'score': 12, 'pv': [0, 1]}]}
        process = FakeProcess(json.dumps(update) + '\n{"type":"done","timed_out":false}\n')
        with patch('analysis.os.path.isfile', return_value=True), patch('analysis.subprocess.Popen', return_value=process):
            response = self.client.post('/api/analysis/start', json={'moves': [0, 1], 'top': 3})
            self.assertEqual(response.status_code, 202)
            token = response.json['job_id']
            result = self.wait_finished(token)
            self.assertEqual(result['depth'], 2)
            self.assertIsNone(result['error'])
            result['moves'].clear()
            self.assertTrue(self.manager.status(token)['moves'], 'Snapshots must be copies')

    def test_old_engine_fails_cleanly(self):
        with patch('analysis.os.path.isfile', return_value=True), patch('analysis.subprocess.Popen', return_value=FakeProcess('Menu: choose an option\n')):
            token = self.manager.start({'moves': []})['job_id']
            self.assertIn('Rebuild', self.wait_finished(token)['error'])

    def wait_finished(self, token):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = self.manager.status(token)
            if not result['running']:
                return result
            # Yield only in this bounded unit-test harness, not in HTTP handlers.
            self.manager._closed.wait(0.005)
        self.fail('Worker did not finish')


class FakeProcess:
    def __init__(self, output):
        self.stdout = io.StringIO(output)
        self.returncode = None

    def poll(self):
        return self.returncode

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


ENGINE = os.path.join(os.path.dirname(__file__), 'bin', 'connect4_3D.exe')


@unittest.skipUnless(os.path.isfile(ENGINE), 'Build/deploy the V3 engine for integration tests')
class EngineIntegrationTests(unittest.TestCase):
    def command(self, moves, top=3):
        result = subprocess.run([ENGINE, 'analyze', moves, str(top), '4', '10000'],
                                capture_output=True, text=True, timeout=15, check=True)
        return [json.loads(line) for line in result.stdout.splitlines()]

    def test_even_depths_ranked_moves_and_dark_orientation(self):
        for history in ('-', '0'):
            updates = self.command(history, 16)
            iterations = [u for u in updates if u['type'] == 'iteration']
            self.assertEqual([u['depth'] for u in iterations], [2, 4])
            for update in iterations:
                self.assertEqual(len(update['moves']), 16)
                scores = [r['score'] for r in update['moves']]
                self.assertEqual(scores, sorted(scores, reverse=history == '-'))
                for row in update['moves']:
                    self.assertEqual(row['pv'][0], row['move'])
                    self.assertTrue(all(0 <= c < 16 for c in row['pv']))

    def test_terminal_and_immediate_mate(self):
        terminal = self.command('0,4,1,5,2,6,3')[0]
        self.assertEqual((terminal['type'], terminal['winner'], terminal['moves']), ('terminal', 1, []))
        row = self.command('0,4,1,5,2,6')[0]['moves'][0]
        self.assertEqual((row['move'], row['score'], row['mate_plies']), (3, 29999, 1))

    def test_cancel_capacity_and_reap(self):
        manager = AnalysisManager(ENGINE, max_workers=1, lease_seconds=0.01)
        try:
            from analysis import AnalysisBusy
            first = manager.start({'moves': []})['job_id']
            process = manager._jobs[first].process
            with self.assertRaises(AnalysisBusy):
                manager.start({'moves': [0]})
            manager.stop(first)
            self.assertIsNotNone(process.wait(timeout=3))
            self.assertIsNone(manager.status(first))
            second = manager.start({'moves': [0]})['job_id']
            process = manager._jobs[second].process
            process.wait(timeout=3)  # reaper must kill an unpolled deep search
            self.assertIsNone(manager.status(second))
        finally:
            manager.close()


if __name__ == '__main__':
    unittest.main()