import torch
import torch.nn as nn
import numpy as np
from flask import Flask, render_template, request, jsonify, session
import subprocess
import os
import re

# --- Local Imports ---
from game_logic import ConnectFour3D
from ai_agent import ResNet3D, MCTS
from puzzle_bank import (PuzzleBank, GenerationManager,
                         CATEGORIES, CATEGORY_BY_KEY, category_for_mate)

# --- 1. INITIALIZATION ---

# Create the Flask application
app = Flask(__name__)
# A secret key is required for using sessions
app.secret_key = 'a-super-secret-key-for-your-app' 

# Set up PyTorch device
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"Using device: {device}")

# Game and AI Hyperparameters (should match your trained model's config)
args = {
    'C': 2.0,
    'num_simulations': 500, # Number of MCTS simulations for AI move
    # Add other args if your MCTS needs them (e.g., dirichlet)
    'dirichlet_epsilon': 0.0,
    'dirichlet_alpha': 0.3,
}

# --- 2. LOAD THE MODEL (ONCE AT STARTUP) ---

def detect_model_config(state_dict):
    """
    Infer the ResNet3D architecture (num_resBlocks, num_hidden) directly from a
    saved state_dict, so app.py stays in sync with whatever checkpoint is loaded
    instead of relying on hard-coded hyperparameters.

    - num_hidden  = out-channels of the start block conv (Conv3d(4, num_hidden, ...)),
                    i.e. the first dimension of 'startBlock.0.weight'.
    - num_resBlocks = number of residual blocks in the backbone, i.e. one more than
                    the highest index seen in 'backBone.<i>.*' keys.
    """
    num_hidden = state_dict['startBlock.0.weight'].shape[0]

    block_indices = set()
    for key in state_dict:
        m = re.match(r'backBone\.(\d+)\.', key)
        if m:
            block_indices.add(int(m.group(1)))
    num_resBlocks = (max(block_indices) + 1) if block_indices else 0

    return num_resBlocks, num_hidden

# Instantiate the game
game = ConnectFour3D()

# Load the trained model weights, auto-detecting the architecture from the checkpoint
model_path = 'models/model_best.pth' # Make sure this path is correct
try:
    state_dict = torch.load(model_path, map_location=device)
    # Unwrap common checkpoint containers if the file isn't a bare state_dict.
    if 'startBlock.0.weight' not in state_dict:
        for key in ('state_dict', 'model_state_dict', 'model'):
            if isinstance(state_dict.get(key), dict):
                state_dict = state_dict[key]
                break

    # Detect architecture from the weights and keep `args` in sync.
    num_resBlocks, num_hidden = detect_model_config(state_dict)
    n_params = sum(v.numel() for v in state_dict.values())
    print(f"Detected model architecture: num_resBlocks={num_resBlocks}, "
          f"num_hidden={num_hidden} ({n_params:,} parameters)")

    model = ResNet3D(game, num_resBlocks, num_hidden, device)
    model.load_state_dict(state_dict)
    model.eval() # Set the model to evaluation mode
    print(f"Model loaded successfully from {model_path}")
except FileNotFoundError:
    print(f"ERROR: Model file not found at {model_path}. The AI will not work.")
    model = None # Set model to None to handle the error gracefully

# Instantiate the MCTS search
mcts = MCTS(game, args, model)


# --- 2b. PUZZLE BANK (engine-generated puzzles for Puzzle Mode) ---

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUZZLE_DIR = os.path.join(BASE_DIR, 'puzzles')
ENGINE_EXE = os.path.join(BASE_DIR, 'bin', 'connect4_3D.exe')

puzzle_bank = PuzzleBank(PUZZLE_DIR)
generation_manager = GenerationManager(puzzle_bank, ENGINE_EXE, PUZZLE_DIR)
print(f"Puzzle bank loaded from {PUZZLE_DIR}: {puzzle_bank.counts()} "
      f"(total {puzzle_bank.total()})")


# --- 3. DEFINE API ROUTES (MODIFIED SECTION) ---

@app.route('/')
def index():
    """ Renders the main game page. """
    return render_template('index.html')

@app.route('/api/new_game', methods=['POST'])
def new_game():
    """ Starts a new game by resetting the board state in the session. """
    initial_state = game.get_initial_state()
    session['board_state'] = initial_state.tolist()
    session['move_history'] = []  # Reset move history
    return jsonify({
        "message": "New game started!",
        "board": session['board_state'],
        "move_history": session['move_history']
    })


# ENDPOINT: Handles only the AI's move
@app.route('/api/ai_move', methods=['POST'])
def ai_move():
    """ Takes the current board state and computes the AI's response. """
    if model is None:
        return jsonify({"error": "AI Model is not loaded!"}), 500

    # Retrieve the board state (which now includes the player's last move)
    board_state_list = session.get('board_state')
    move_history = session.get('move_history', [])
    if board_state_list is None:
        return jsonify({"error": "Game not started."}), 400
    
    state = np.array(board_state_list, dtype=np.int8)

    # --- AI's Move ---
    ai_action_probs = mcts.search(state)
    ai_action = int(np.argmax(ai_action_probs))

    # The frontend will handle state updates. Just return the move.
    return jsonify({"move": ai_action})

@app.route('/api/minimax_move', methods=['POST'])
def minimax_move():
    """
    Gets a move from the external C++ minimax executable.
    Expects a JSON body with two hex strings: {'hex_p1': '...', 'hex_p2': '...'}
    Returns a simple JSON response with the move: {'move': <int>}
    """
    data = request.get_json()
    hex_p1 = data.get('hex_p1')
    hex_p2 = data.get('hex_p2')

    if not hex_p1 or not hex_p2:
        return jsonify({"error": "Missing hex codes for one or both players."}), 400

    try:
        executable_path = os.path.join('bin', 'connect4_3D.exe')
        
        engine = subprocess.Popen(
            [executable_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            universal_newlines=True
        )
        
        # Write commands to the engine
        engine.stdin.write("10\n")
        engine.stdin.write(f"{hex_p1} {hex_p2}\n1\n2\nm\n99\n")
        engine.stdin.flush()

        # Read output
        stdout, stderr = engine.communicate()
        print(f"Engine stdout:\n {stdout}")
        if engine.returncode != 0:
            raise Exception(f"Engine exited with error code {engine.returncode}: {stderr}")

        # Find the move in the output
        match = re.search(r'\*\*(\d+)\*\*', stdout)
        if not match:
            raise Exception(f"Could not find move in engine output. Output: {stdout}")
            
        ai_action = int(match.group(1))
        
        # Return just the move
        return jsonify({"move": ai_action})

    except Exception as e:
        print(f"Error during minimax move calculation: {e}")
        return jsonify({"error": "Failed to get move from minimax AI."}), 500


@app.route('/api/set_state', methods=['POST'])
def set_state():
    """
    Explicitly sets the board state and move history in the session.
    """
    data = request.get_json()
    board_state = data.get('board_state')
    move_history = data.get('move_history')

    if board_state is None or move_history is None:
        return jsonify({"error": "Missing board_state or move_history."}), 400

    session['board_state'] = board_state
    session['move_history'] = move_history

    return jsonify({"message": "State updated successfully."})


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
        empty_msg = f"No {cat['label']} puzzles in the bank yet. The engine is generating — try again shortly."
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
        "category": category_for_mate(puzzle['mate']),
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
    # Use threaded=False to avoid issues with PyTorch model in multi-threaded context
    app.run(debug=True, threaded=False, port=5000)