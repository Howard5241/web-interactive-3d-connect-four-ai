import mimetypes
import os

from flask import Flask, render_template, request, jsonify, session

from puzzle_bank import (PuzzleBank, GenerationManager,
                         CATEGORIES, CATEGORY_BY_KEY, category_for_mate, mate_length)
from room_state import RoomRegistry, clean_client_id

# Browsers only stream-compile WebAssembly served as application/wasm.
mimetypes.add_type('application/wasm', '.wasm')

app = Flask(__name__)
app.secret_key = 'a-super-secret-key-for-your-app'


@app.after_request
def cross_origin_isolate(response):
    # Lets the browser AI use multi-threaded WebAssembly when WebGPU is unavailable.
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    response.headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
    return response


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUZZLE_DIR = os.path.join(BASE_DIR, 'puzzles')
ENGINE_EXE = os.path.join(BASE_DIR, 'bin', 'connect4_3D.exe')

puzzle_bank = PuzzleBank(PUZZLE_DIR)
generation_manager = GenerationManager(
    puzzle_bank, ENGINE_EXE, PUZZLE_DIR,
    seeds=int(os.environ.get('PUZZLE_SEEDS', '400')),
    batch_seconds=float(os.environ.get('PUZZLE_BATCH_SECONDS', '180')),
    candidate_seconds=float(os.environ.get('PUZZLE_CANDIDATE_SECONDS', '30')),
    min_steps=int(os.environ.get('PUZZLE_MIN_STEPS', '2')),
    distance_seconds=float(os.environ.get('PUZZLE_DISTANCE_SECONDS', '45')),
)
print(f"Puzzle bank loaded from {PUZZLE_DIR}: {puzzle_bank.counts()} "
      f"(total {puzzle_bank.total()})")

rooms = RoomRegistry()


@app.route('/')
def index():
    return render_template('index.html')


def _room_for(room_id, client_id):
    room = rooms.get(room_id)
    room.touch(clean_client_id(client_id))
    return room


@app.route('/api/room/state', methods=['GET'])
def room_get_state():
    """Poll for room changes; also the presence heartbeat."""
    try:
        room = _room_for(request.args.get('room'), request.args.get('client_id'))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    return jsonify(room.snapshot(
        since=request.args.get('since', type=int),
        log_since=request.args.get('log_since', type=int),
    ))


@app.route('/api/room/state', methods=['POST'])
def room_push_state():
    """Apply a patch; with `base_version` it is rejected (409) if the room has moved on."""
    data = request.get_json(silent=True) or {}
    try:
        room = _room_for(data.get('room'), data.get('client_id'))
        accepted, snapshot = room.apply_patch(
            data.get('patch') or {},
            clean_client_id(data.get('client_id')),
            base_version=data.get('base_version'),
            log=data.get('log'),
            log_since=data.get('log_since'),
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    snapshot['accepted'] = accepted
    return jsonify(snapshot), (200 if accepted else 409)


@app.route('/api/room/leave', methods=['POST'])
def room_leave():
    """Sent by sendBeacon as text/plain, hence force=True."""
    data = request.get_json(force=True, silent=True) or {}
    try:
        client_id = clean_client_id(data.get('client_id'))
        rooms.get(data.get('room')).leave(client_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"left": True})


@app.route('/api/puzzle', methods=['GET'])
def get_puzzle():
    """A random puzzle by `category`, or by a single `mate` length, avoiding recent repeats."""
    category_key = request.args.get('category')
    if category_key is not None:
        cat = CATEGORY_BY_KEY.get(category_key)
        if cat is None:
            return jsonify({"error": f"Unknown category '{category_key}'."}), 400
        served_key = category_key
        min_mate, max_mate = cat['min'], cat['max']
        empty_msg = f"No puzzles in '{cat['label']}' yet. The engine is generating — try again shortly."
    else:
        try:
            mate = int(request.args.get('mate', 1))
            if mate < 1:
                raise ValueError
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid mate length."}), 400
        served_key = f"mate{mate}"
        min_mate = max_mate = mate
        empty_msg = f"No mate-in-{mate} puzzles in the bank yet. Try again shortly."

    served = session.get('served_puzzles', {})
    recent = served.get(served_key, [])
    puzzle = puzzle_bank.get_random_range(min_mate, max_mate, exclude_ids=recent)

    if puzzle is None:
        return jsonify({
            "error": empty_msg,
            "empty": True,
            "counts": puzzle_bank.counts(),
            "category_counts": puzzle_bank.category_counts(),
        }), 404

    served[served_key] = ([puzzle['id']] + recent)[:30]
    session['served_puzzles'] = served

    return jsonify({
        "history": puzzle['history'],
        "solution": puzzle['solution'],
        "mate": puzzle['mate'],
        "steps": puzzle['steps'],
        "goal": puzzle['goal'],
        "category": category_for_mate(mate_length(puzzle)),
        "id": puzzle['id'],
        "counts": puzzle_bank.counts(),
        "category_counts": puzzle_bank.category_counts(),
    })


@app.route('/api/puzzle/counts', methods=['GET'])
def puzzle_counts():
    return jsonify({
        "counts": puzzle_bank.counts(),
        "category_counts": puzzle_bank.category_counts(),
        "categories": CATEGORIES,
        "total": puzzle_bank.total(),
    })


@app.route('/api/puzzle/generate/start', methods=['POST'])
def generate_start():
    started, status = generation_manager.start()
    return jsonify({"started": started, "status": status})


@app.route('/api/puzzle/generate/stop', methods=['POST'])
def generate_stop():
    return jsonify({"status": generation_manager.stop()})


@app.route('/api/puzzle/generate/status', methods=['GET'])
def generate_status():
    return jsonify({"status": generation_manager.status()})


if __name__ == '__main__':
    app.run(debug=True, threaded=False, port=5000)