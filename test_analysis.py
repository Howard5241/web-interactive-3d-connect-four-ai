"""Analysis API/worker tests; no neural model is loaded for these tests."""
import io
import json
import os
import random
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

    def test_display_depth_parity(self):
        for moves, expected in (([], 4), ([0], 3)):
            updates = [{'type': 'iteration', 'depth': depth, 'complete': False,
                        'moves': [{'move': 1, 'score': depth, 'pv': [1]}]}
                       for depth in range(1, 5)]
            output = '\n'.join(json.dumps(update) for update in updates) + '\n{"type":"done"}\n'
            with self.subTest(moves=moves), patch('analysis.os.path.isfile', return_value=True), \
                    patch('analysis.subprocess.Popen', return_value=FakeProcess(output)):
                token = self.manager.start({'moves': moves})['job_id']
                result = self.wait_finished(token)
                self.assertEqual(result['depth'], expected)
                self.assertEqual(result['moves'][0]['score'], expected)
                self.assertIsNone(result['error'])

    def test_proved_result_bypasses_parity(self):
        update = {'type': 'iteration', 'depth': 1, 'complete': True,
                  'moves': [{'move': 0, 'score': -29998, 'solved': True, 'pv': [0]}]}
        output = json.dumps(update) + '\n{"type":"done"}\n'
        with patch('analysis.os.path.isfile', return_value=True), \
                patch('analysis.subprocess.Popen', return_value=FakeProcess(output)):
            token = self.manager.start({'moves': []})['job_id']
            result = self.wait_finished(token)
            self.assertEqual(result['depth'], 1)
            self.assertTrue(result['complete'])

    def wait_finished(self, token):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = self.manager.status(token)
            if not result['running']:
                return result
            # Yield only in this bounded unit-test harness, not in HTTP handlers.
            self.manager._closed.wait(0.005)
        self.fail('Worker did not finish')

    def test_mate_progress_bypasses_parity_and_survives_timeout(self):
        updates = [
            {'type': 'iteration', 'depth': 37, 'complete': True, 'phase': 'mate',
             'mate_complete': False,
             'moves': [{'move': 1, 'score': 30000, 'solved': True, 'mate_plies': None,
                        'mate_exact': False, 'pv': [1]}]},
            # A distance completion can arrive at an odd depth on Light's turn.
            {'type': 'iteration', 'depth': 37, 'complete': False, 'phase': 'mate',
             'mate_complete': False,
             'moves': [{'move': 1, 'score': 29993, 'solved': True, 'mate_plies': 7,
                        'mate_exact': True, 'pv': [1, 2]}]},
            {'type': 'done', 'timed_out': True},
        ]
        output = '\n'.join(map(json.dumps, updates)) + '\n'
        with patch('analysis.os.path.isfile', return_value=True), \
                patch('analysis.subprocess.Popen', return_value=FakeProcess(output)):
            token = self.manager.start({'moves': []})['job_id']
            result = self.wait_finished(token)
            self.assertEqual(result['phase'], 'mate')
            self.assertTrue(result['timed_out'])
            self.assertFalse(result['mate_complete'])
            self.assertEqual(result['moves'][0]['mate_plies'], 7)
            self.assertTrue(result['moves'][0]['mate_exact'])
            self.assertIsNone(result['error'])

    def test_mate_completion_snapshot(self):
        update = {'type': 'iteration', 'depth': 11, 'complete': True, 'phase': 'complete',
                  'mate_complete': True, 'moves': [
                      {'move': 2, 'score': -29996, 'solved': True, 'mate_plies': 4,
                       'mate_exact': True, 'pv': [2, 4]}]}
        output = json.dumps(update) + '\n{"type":"done","timed_out":false}\n'
        with patch('analysis.os.path.isfile', return_value=True), \
                patch('analysis.subprocess.Popen', return_value=FakeProcess(output)):
            token = self.manager.start({'moves': []})['job_id']
            result = self.wait_finished(token)
            self.assertTrue(result['mate_complete'])
            self.assertEqual(result['phase'], 'complete')
            self.assertEqual(result['moves'][0]['mate_plies'], 4)


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


@unittest.skipUnless(os.path.isfile(ENGINE), 'Build/deploy the V4 engine for integration tests')
class EngineIntegrationTests(unittest.TestCase):
    def command(self, moves, top=3):
        result = subprocess.run([ENGINE, 'analyze', moves, str(top), '4', '10000'],
                                capture_output=True, text=True, timeout=15, check=True)
        return [json.loads(line) for line in result.stdout.splitlines()]

    def test_every_depth_ranked_moves_and_dark_orientation(self):
        for history in ('-', '0'):
            updates = self.command(history, 16)
            iterations = [u for u in updates if u['type'] == 'iteration']
            self.assertEqual([u['depth'] for u in iterations], [1, 2, 3, 4])
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
        self.assertTrue(row['mate_exact'])

    def test_exact_mate_refinement_all_moves_both_colors(self):
        # Construct late nonterminal histories independently of the C++ fixtures.
        # Tiny exhaustive distance oracle: no production threats or pruning.
        rng = random.Random(9082641)
        for pieces in (54, 55):
            for _ in range(10000):
                boards, heights, history = [0, 0], [0] * 16, []
                for ply in range(pieces):
                    columns = list(range(16))
                    rng.shuffle(columns)
                    for col in columns:
                        if heights[col] == 4:
                            continue
                        bit = 1 << (col + 16 * heights[col])
                        candidate = boards[ply % 2] | bit
                        if any(candidate & mask == mask for mask in WINNING_MASKS):
                            continue
                        boards[ply % 2] = candidate
                        heights[col] += 1
                        history.append(col)
                        break
                    else:
                        break
                if len(history) == pieces:
                    break
            self.assertEqual(len(history), pieces)
            memo = {}

            def oracle(board, side):
                key = (*board, side)
                if key in memo:
                    return memo[key]
                occupied = board[0] | board[1]
                count = occupied.bit_count()
                best = -32000
                for col in range(16):
                    for z in range(4):
                        bit = 1 << (col + 16 * z)
                        if occupied & bit:
                            continue
                        child = list(board)
                        child[side] |= bit
                        won = any(child[side] & mask == mask for mask in WINNING_MASKS)
                        score = 30000 - count - 1 if won else -oracle(child, 1 - side)
                        best = max(best, score)
                        break
                memo[key] = 0 if best == -32000 else best
                return memo[key]

            expected = {}
            side = pieces % 2
            for col, height in enumerate(heights):
                if height == 4:
                    continue
                child = boards.copy()
                child[side] |= 1 << (col + 16 * height)
                won = any(child[side] & mask == mask for mask in WINNING_MASKS)
                value = 30000 - pieces - 1 if won else -oracle(child, 1 - side)
                if value:
                    value += pieces if value > 0 else -pieces
                expected[col] = value if side == 0 else -value

            result = subprocess.run([ENGINE, 'analyze', ','.join(map(str, history)), '16', '64', '10000'],
                                    capture_output=True, text=True, timeout=15, check=True)
            updates = [json.loads(line) for line in result.stdout.splitlines()]
            final = [update for update in updates if update['type'] == 'iteration'][-1]
            self.assertTrue(final['mate_complete'])
            self.assertEqual(final['phase'], 'complete')
            self.assertEqual({row['move']: row['score'] for row in final['moves']}, expected)
            scores = [row['score'] for row in final['moves']]
            self.assertEqual(scores, sorted(scores, reverse=side == 0))
            for row in final['moves']:
                self.assertTrue(row['solved'])
                self.assertTrue(row['mate_exact'])
                self.assertEqual(row['mate_plies'], 30000 - abs(row['score']) if row['score'] else None)
            self.assertFalse(updates[-1]['timed_out'])

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