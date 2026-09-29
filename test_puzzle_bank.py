import json
import os
import tempfile
import unittest

from puzzle_bank import PuzzleBank, parse_generated_file


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

    def test_legacy_category_uses_objective_mate_length(self):
        """The file name labels the objective mate, so a one-move legacy line is
        still a mate in 8, not a quick puzzle."""
        with open(os.path.join(self.temp.name, 'mate_in_8.txt'), 'w') as stream:
            stream.write('0 1 2 3\n4\n\n')
        self.write([self.record])
        bank = PuzzleBank(self.temp.name)
        self.assertEqual(bank.total(), 2)
        self.assertEqual(bank.category_counts()['long'], 1)   # mate in 8
        self.assertEqual(bank.category_counts()['quick'], 1)  # the drawn record
        self.assertEqual(bank.get_random(8)['mate'], 8)
        self.assertEqual(bank.get_random(2)['goal'], 'draw')

    def test_category_follows_the_proved_distance_not_the_line_length(self):
        """A short recorded line inside a long mate belongs to the long category:
        distance is plies, the solver plays the odd ones, so 17 plies is a mate
        in 9. Without a proved distance there is nothing to group by but steps."""
        self.write([
            dict(self.record, position='11:22', goal='win', distance=17),  # mate in 9
            dict(self.record, position='33:44', goal='win', distance=3),   # mate in 2
            dict(self.record, position='55:66', goal='win'),               # unproved
            dict(self.record, position='77:88'),                           # draw
        ])
        bank = PuzzleBank(self.temp.name)
        self.assertEqual(bank.counts(), {2: 3, 9: 1})  # steps is 2 for all four
        self.assertEqual(bank.category_counts()['long'], 1)
        self.assertEqual(bank.category_counts()['quick'], 3)
        self.assertEqual(bank.get_random(9)['distance'], 17)

    def test_distance_is_optional_and_never_blocks_loading(self):
        """Records predate the distance step, and a batch can fail to prove one."""
        self.write([dict(self.record, distance=9),
                    dict(self.record, position='56:78'),
                    dict(self.record, position='9a:bc', distance='three')])
        self.assertEqual(len(parse_generated_file(self.path)), 3)


if __name__ == '__main__':
    unittest.main()