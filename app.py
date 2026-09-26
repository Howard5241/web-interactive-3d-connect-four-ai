from flask import Flask, render_template, request, jsonify, session
import mimetypes
import os

# --- Local Imports ---
from puzzle_bank import (PuzzleBank, GenerationManager,
                         CATEGORIES, CATEGORY_BY_KEY, category_for_mate, mate_length)
from room_state import RoomRegistry, clean_client_id

# --- 1. INITIALIZATION ---

# Analysis mode, the minimax opponent and the neural-network opponent all run in the
# browser (static/engine/, static/nn/; see static/js/engine.js and nnAgent.js). Some
# platforms' MIME tables lack .wasm, and browsers only stream-compile a module served
# as application/wasm.
mimetypes.add_type('application/wasm', '.wasm')

# Create the Flask application
app = Flask(__name__)
# A secret key is required for using sessions
app.secret_key = 'a-super-secret-key-for-your-app' 


@app.after_request
def cross_origin_isolate(response):
    # Cross-origin isolation lets the in-browser AI run WebAssembly on several threads
    # when WebGPU is unavailable.
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    response.headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
    return response


# --- 2b. PUZZLE BANK (engine-generated puzzles for Puzzle Mode) ---

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


# --- 2c. SHARED ROOMS (one board for everyone looking at the site) ---

rooms = RoomRegistry()


# --- 3. DEFINE API ROUTES (MODIFIED SECTION) ---

@app.route('/')
def index():
    """ Renders the main game page. """
    return render_template('index.html')

# --- SHARED ROOM ENDPOINTS ---
#
# The board every viewer sees lives in the room, not in the browser. Clients poll
# GET for changes and POST their own; see room_state.py for the protocol.

def _room_for(room_id, client_id):
    """Resolve the room and register the caller as a live viewer."""
    room = rooms.get(room_id)
    room.touch(clean_client_id(client_id))
    return room


@app.route('/api/room/state', methods=['GET'])
def room_get_state():
    """Poll for room changes; also the presence heartbeat that keeps the caller listed."""
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
    """Apply a patch to the shared state.

    A patch sent with `base_version` is only applied if the room is still on that
    version, so simultaneous moves from two viewers cannot both land: the loser gets
    409 plus the state it missed.
    """
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
    """Drop a viewer from the presence list as its tab closes (sent via sendBeacon,
    which posts text/plain, hence force=True)."""
    data = request.get_json(force=True, silent=True) or {}
    try:
        client_id = clean_client_id(data.get('client_id'))
        rooms.get(data.get('room')).leave(client_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"left": True})


# --- PUZZLE MODE ENDPOINTS ---

@app.route('/api/puzzle', methods=['GET'])
def get_puzzle():
    """Serve a random engine-generated puzzle, avoiding ones recently served to this
    session. Prefer the `category` param (quick/medium/long/endgame); a bare `mate`
    param is still accepted for a single mate length."""
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

    # Remember this id to avoid immediate repeats (cap history so the cookie stays small).
    served[served_key] = ([puzzle['id']] + recent)[:30]
    session['served_puzzles'] = served

    return jsonify({
        "history": puzzle['history'],
        "solution": puzzle['solution'],
        "mate": puzzle['mate'],
        "steps": puzzle['steps'],
        "goal": puzzle['goal'],
        # The bucket it was drawn from, so the client's label matches the
        # request. `mate` stays as-is: the exact mate distance is deliberately
        # not shown to the solver, only the band the category already implies.
        "category": category_for_mate(mate_length(puzzle)),
        "id": puzzle['id'],
        "counts": puzzle_bank.counts(),
        "category_counts": puzzle_bank.category_counts(),
    })


@app.route('/api/puzzle/counts', methods=['GET'])
def puzzle_counts():
    """Available puzzles per mate length and per category, plus the category defs."""
    return jsonify({
        "counts": puzzle_bank.counts(),
        "category_counts": puzzle_bank.category_counts(),
        "categories": CATEGORIES,
        "total": puzzle_bank.total(),
    })


@app.route('/api/puzzle/generate/start', methods=['POST'])
def generate_start():
    """Begin continuous background generation (small, interruptible batches that
    grow every mate-length bucket). Idempotent while already running."""
    started, status = generation_manager.start()
    return jsonify({"started": started, "status": status})


@app.route('/api/puzzle/generate/stop', methods=['POST'])
def generate_stop():
    """Stop continuous generation and free the engine immediately."""
    return jsonify({"status": generation_manager.stop()})


@app.route('/api/puzzle/generate/status', methods=['GET'])
def generate_status():
    """Poll the continuous background generator (running flag, session total, counts)."""
    return jsonify({"status": generation_manager.status()})


# --- RUN THE APP ---

if __name__ == '__main__':
    app.run(debug=True, threaded=False, port=5000)