"""Bounded, cancellable V4 analysis workers. HTTP only reads short snapshots.

Each opaque job token owns one engine/TT. A heartbeat lease reaps abandoned tabs;
neither searches nor their stdout readers ever occupy Flask's request thread.
"""
from __future__ import annotations

import atexit
import copy
import itertools
import json
import os
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field

from flask import Blueprint, jsonify, request


def _winning_masks():
    masks = set()
    for start in itertools.product(range(4), repeat=3):
        for delta in itertools.product((-1, 0, 1), repeat=3):
            if delta == (0, 0, 0):
                continue
            cells = [tuple(start[a] + n * delta[a] for a in range(3)) for n in range(4)]
            if all(all(0 <= v < 4 for v in cell) for cell in cells):
                masks.add(sum(1 << (z * 16 + y * 4 + x) for z, y, x in cells))
    return tuple(masks)


WINNING_MASKS = _winning_masks()


def validate_request(data):
    if not isinstance(data, dict):
        raise ValueError('Expected a JSON object.')
    moves = data.get('moves')
    top = data.get('top', 3)
    if not isinstance(moves, list) or len(moves) > 64:
        raise ValueError('moves must be a list of at most 64 columns.')
    if type(top) is not int or not 1 <= top <= 16:
        raise ValueError('top must be an integer from 1 to 16.')
    heights, boards, ended = [0] * 16, [0, 0], False
    for index, column in enumerate(moves):
        if type(column) is not int or not 0 <= column < 16:
            raise ValueError('Columns must be integers from 0 to 15.')
        if ended or heights[column] == 4:
            raise ValueError('History contains a move after game over or into a full column.')
        side = index % 2
        boards[side] |= 1 << (column + 16 * heights[column])
        heights[column] += 1
        ended = any(boards[side] & mask == mask for mask in WINNING_MASKS)
    return list(moves), top


class AnalysisBusy(Exception):
    pass


@dataclass
class AnalysisJob:
    process: subprocess.Popen
    touched: float = field(default_factory=time.monotonic)
    snapshot: dict = field(default_factory=lambda: {
        'running': True, 'depth': 0, 'moves': [], 'nodes': 0,
        'elapsed_ms': 0, 'complete': False, 'error': None,
    })


class AnalysisManager:
    def __init__(self, executable, max_workers=2, lease_seconds=20):
        self.executable = executable
        self.max_workers = max_workers
        self.lease_seconds = lease_seconds
        self._jobs: dict[str, AnalysisJob] = {}
        self._lock = threading.RLock()
        self._closed = threading.Event()
        threading.Thread(target=self._reap, daemon=True, name='analysis-reaper').start()
        atexit.register(self.close)

    def start(self, data):
        moves, top = validate_request(data)
        with self._lock:
            if sum(job.process.poll() is None for job in self._jobs.values()) >= self.max_workers:
                raise AnalysisBusy('Analysis workers are busy. Pause another analysis or retry shortly.')
            if not os.path.isfile(self.executable):
                raise FileNotFoundError('Analysis engine is missing. Build and deploy the V4 engine first.')
            # Always take every ranked root move. Analysis values all sixteen columns
            # regardless, so capping the engine's output here would only make the
            # display count a search parameter: widening the panel would then have to
            # restart the process and discard its table, depth and proof progress.
            # `top` stays part of the request contract; the client picks how many rows
            # of the snapshot it draws.
            process = subprocess.Popen(
                [self.executable, 'analyze', ','.join(map(str, moves)) or '-', '16', '64', '1800000'],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, encoding='utf-8', bufsize=1,
                creationflags=(getattr(subprocess, 'CREATE_NO_WINDOW', 0)
                               | getattr(subprocess, 'BELOW_NORMAL_PRIORITY_CLASS', 0)),
            )
            token = uuid.uuid4().hex
            job = AnalysisJob(process)
            job.snapshot.update(job_id=token, position=moves, top=top)
            self._jobs[token] = job
            threading.Thread(target=self._read, args=(job,), daemon=True, name='analysis-reader').start()
            return copy.deepcopy(job.snapshot)

    def _read(self, job):
        received = False
        try:
            assert job.process.stdout is not None
            for line in job.process.stdout:
                # Old deployed binaries print a menu. Fail promptly, not a frozen UI.
                update = json.loads(line)
                if not isinstance(update, dict) or update.get('type') not in ('iteration', 'terminal', 'done'):
                    raise ValueError('Unsupported engine protocol')
                with self._lock:
                    if not job.snapshot['running']:
                        break
                    if update['type'] == 'done':
                        job.snapshot['timed_out'] = bool(update.get('timed_out'))
                    else:
                        received = True
                        # Retain the last matching iteration even if HTTP polling
                        # skips depths: Light uses even, Dark uses odd. Fully
                        # proved results and per-move mate refinements bypass
                        # heuristic parity: their depth is not a heuristic horizon.
                        if (update['type'] == 'iteration' and not update.get('complete')
                            and update.get('phase') != 'mate'
                                and update['depth'] % 2 != len(job.snapshot['position']) % 2):
                            continue
                        job.snapshot.update(update)
            code = job.process.wait(timeout=2)
            with self._lock:
                if job.snapshot['running'] and (code != 0 or not received):
                    job.snapshot['error'] = 'Engine analysis failed. Rebuild and deploy the V4 engine.'
        except (OSError, ValueError, subprocess.TimeoutExpired):
            with self._lock:
                if job.snapshot['running']:
                    job.snapshot['error'] = 'Invalid engine response. Rebuild and deploy the V4 engine.'
        finally:
            self._terminate(job)
            job.process.wait()
            if job.process.stdout:
                job.process.stdout.close()
            with self._lock:
                job.snapshot['running'] = False

    @staticmethod
    def _terminate(job):
        if job.process.poll() is None:
            try:
                job.process.kill()
            except OSError:
                pass  # the process may have exited between poll and kill

    def status(self, token):
        with self._lock:
            job = self._jobs.get(token)
            if job is None:
                return None
            job.touched = time.monotonic()
            return copy.deepcopy(job.snapshot)

    def stop(self, token):
        with self._lock:
            job = self._jobs.pop(token, None)
            if job:
                job.snapshot['running'] = False
                self._terminate(job)

    def _reap(self):
        while not self._closed.wait(1):
            with self._lock:
                expired = [token for token, job in self._jobs.items()
                           if time.monotonic() - job.touched > self.lease_seconds]
                for token in expired:
                    self.stop(token)

    def close(self):
        self._closed.set()
        with self._lock:
            for token in list(self._jobs):
                self.stop(token)


def analysis_blueprint(manager):
    api = Blueprint('analysis', __name__)

    @api.post('/api/analysis/start')
    def start():
        try:
            return jsonify(manager.start(request.get_json(silent=True))), 202
        except ValueError as error:
            return jsonify(error=str(error)), 400
        except AnalysisBusy as error:
            return jsonify(error=str(error)), 429
        except OSError:
            return jsonify(error='Analysis engine unavailable. Build and deploy the V4 engine first.'), 503

    @api.get('/api/analysis/<token>')
    def status(token):
        snapshot = manager.status(token)
        if snapshot is None:
            return jsonify(error='Analysis expired. Press Resume to start again.'), 404
        response = jsonify(snapshot)
        response.headers['Cache-Control'] = 'no-store'
        return response

    @api.post('/api/analysis/<token>/stop')
    def stop(token):
        manager.stop(token)
        return jsonify(stopped=True)

    return api