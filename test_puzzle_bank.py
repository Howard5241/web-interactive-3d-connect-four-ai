import json
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

from puzzle_bank import GenerationManager, PuzzleBank, parse_generated_file
from room_state import _clean_puzzle


class PuzzleBankTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = os.path.join(self.temp.name, 'generated_v3.jsonl')
        self.record = dict(version=3, position='12:34', history=[0, 1, 2, 3],
                           solution=[4, 5, 6], steps=2, goal='draw')

    def write(self, records):
        with open(self.path, 'w', encoding='utf-8') as stream:
            for record in records:
                stream.write(json.dumps(record) + '\n')

    def test_draw_metadata_and_deduplication(self):
        self.write([self.record, self.record])
        bank = PuzzleBank(self.temp.name)
        self.assertEqual(bank.total(), 1)
        puzzle = bank.get_random_range(1, 3)
        self.assertEqual(puzzle['goal'], 'draw')
        self.assertEqual(puzzle['steps'], 2)
        self.assertIsNone(puzzle['mate'])
        self.assertEqual(bank.category_counts()['quick'], 1)
        room = _clean_puzzle(dict(source='engine', category='quick', puzzles=[puzzle]))
        self.assertEqual(room['puzzles'][0]['goal'], 'draw')
        self.assertEqual(room['puzzles'][0]['steps'], 2)

    def test_partial_record_recovery(self):
        self.write([self.record])
        with open(self.path, 'a', encoding='utf-8') as stream:
            stream.write('{"version":3,"position":\n')
            stream.write(json.dumps(dict(self.record, position='56:78')) + '\n')
        self.assertEqual(len(parse_generated_file(self.path)), 2)

    def test_invalid_records(self):
        records = [[], 123, dict(self.record, version=4), dict(self.record, goal='loss'),
                   dict(self.record, steps=3), dict(self.record, solution=[4, 5]),
                   dict(self.record, solution=[True]), dict(self.record, history=[16]),
                   dict(self.record, history=[0] * 5), dict(self.record, position='bad'),
                   dict(self.record, history=None), dict(self.record, solution='4 5 6')]
        self.write(records)
        self.assertEqual(parse_generated_file(self.path), [])

    def test_legacy_category_uses_playable_length(self):
        with open(os.path.join(self.temp.name, 'mate_in_8.txt'), 'w') as stream:
            stream.write('0 1 2 3\n4\n\n')
        self.write([self.record])
        bank = PuzzleBank(self.temp.name)
        self.assertEqual(bank.total(), 2)
        self.assertEqual(bank.category_counts()['quick'], 2)
        self.assertEqual(bank.get_random(1)['mate'], 8)
        bank.rewrite_files()
        bank.reload()
        self.assertEqual(bank.total(), 2)  # V3 metadata must not become legacy mate data
        self.assertEqual(bank.get_random(2)['goal'], 'draw')

    def test_stop_start_and_repeated_start_do_not_deadlock(self):
        bank = PuzzleBank(self.temp.name)
        manager = GenerationManager(bank, 'unused.exe', self.temp.name)
        entered = threading.Event()

        def batch(*args):
            entered.set()
            manager._stop.wait(2)

        with patch.object(manager, '_run_batch', side_effect=batch):
            self.assertTrue(manager.start()[0])
            self.assertTrue(entered.wait(1))
            completed = threading.Event()
            caller = threading.Thread(target=lambda: (manager.start(), completed.set()), daemon=True)
            caller.start()
            self.assertTrue(completed.wait(1), 'Repeated start deadlocked')
            manager.stop()
            manager._thread.join(2)
            self.assertFalse(manager._thread.is_alive())
            self.assertTrue(manager.start()[0])
            manager.stop()
            manager._thread.join(2)
            self.assertFalse(manager.status()['running'])

    def test_stop_during_process_creation(self):
        bank = PuzzleBank(self.temp.name)
        manager = GenerationManager(bank, 'unused.exe', self.temp.name)

        class Process:
            returncode = 0
            killed = False

            def kill(self):
                self.killed = True

            def communicate(self, **kwargs):
                return '', None

        process = Process()

        def spawn(*args, **kwargs):
            manager.stop()  # stop before _proc is published
            return process

        with patch('puzzle_bank.os.path.exists', return_value=True), \
             patch('puzzle_bank.subprocess.Popen', side_effect=spawn):
            manager._run_batch()
        self.assertTrue(process.killed)
        self.assertIsNone(manager._proc)

    def test_worker_failure_stops_loop(self):
        bank = PuzzleBank(self.temp.name)
        manager = GenerationManager(bank, 'unused.exe', self.temp.name)
        with patch.object(manager, '_run_batch', side_effect=RuntimeError('test failure')):
            manager.start()
            manager._thread.join(2)
        self.assertFalse(manager.status()['running'])
        self.assertIn('test failure', manager.status()['message'])

    def test_resource_configuration_is_bounded(self):
        bank = PuzzleBank(self.temp.name)
        for values in [dict(candidate_seconds=121), dict(candidate_seconds=0),
                       dict(batch_seconds=float('nan')), dict(batch_seconds=float('inf')),
                       dict(min_steps=0), dict(seeds=100001),
                       dict(distance_seconds=121), dict(distance_seconds=-1),
                       dict(distance_seconds=float('nan'))]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                GenerationManager(bank, 'unused.exe', self.temp.name, **values)

    def test_batch_requests_the_distance_step(self):
        """The engine's arguments are positional, so the distance allowance only
        arrives if the two defaults before it are restated correctly."""
        bank = PuzzleBank(self.temp.name)
        manager = GenerationManager(bank, 'unused.exe', self.temp.name,
                                    min_steps=3, distance_seconds=7)
        captured = []

        class Process:
            returncode = 0

            def kill(self):
                pass

            def communicate(self, **kwargs):
                return '', None

        def spawn(args, **kwargs):
            captured.append(args)
            return Process()

        with patch('puzzle_bank.os.path.exists', return_value=True), \
             patch('puzzle_bank.subprocess.Popen', side_effect=spawn):
            manager._run_batch(26, 28)
        self.assertEqual(captured[0][1], 'genpuzzle')
        self.assertEqual(captured[0][-3:], ['0', '3', '7'])  # random seed, min playable, distance
        # Zero disables the step rather than passing a zero-length deadline on.
        manager.distance_seconds = 0
        captured.clear()
        with patch('puzzle_bank.os.path.exists', return_value=True), \
             patch('puzzle_bank.subprocess.Popen', side_effect=spawn):
            manager._run_batch(26, 28)
        self.assertEqual(captured[0][-1], '0')

    def test_distance_is_optional_and_never_blocks_loading(self):
        """Records predate the distance step, and a batch can fail to prove one."""
        self.write([dict(self.record, distance=9),
                    dict(self.record, position='56:78'),
                    dict(self.record, position='9a:bc', distance='three')])
        self.assertEqual(len(parse_generated_file(self.path)), 3)


if __name__ == '__main__':
    unittest.main()