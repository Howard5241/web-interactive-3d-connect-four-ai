import torch
import torch.nn as nn
import numpy as np
from flask import Flask, render_template, request, jsonify, session

# --- Local Imports ---
from game_logic import ConnectFour3D
from ai_agent import ResNet3D, MCTS

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
    'num_simulations': 1000, # Number of MCTS simulations for AI move
    'num_resBlocks': 4,
    'num_hidden': 64,
    # Add other args if your MCTS needs them (e.g., dirichlet)
    'dirichlet_epsilon': 0.0,
    'dirichlet_alpha': 0.3,
}

# --- 2. LOAD THE MODEL (ONCE AT STARTUP) ---

# Instantiate the game and model
game = ConnectFour3D()
model = ResNet3D(game, args['num_resBlocks'], args['num_hidden'], device)

# Load the trained model weights
try:
    model_path = 'models/model_best.pth' # Make sure this path is correct
    model.load_state_dict(torch.load(model_path, map_location=device))
    model.eval() # Set the model to evaluation mode
    print(f"Model loaded successfully from {model_path}")
except FileNotFoundError:
    print(f"ERROR: Model file not found at {model_path}. The AI will not work.")
    model = None # Set model to None to handle the error gracefully

# Instantiate the MCTS search
mcts = MCTS(game, args, model)


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

# NEW ENDPOINT 1: Handles only the player's move
@app.route('/api/player_move', methods=['POST'])
def player_move():
    """ Handles only the player's move and returns the updated board immediately. """
    # Get the player's move from the request
    data = request.get_json()
    player_action = data.get('column')

    # Retrieve the current board state from the session
    board_state_list = session.get('board_state')
    move_history = session.get('move_history', [])
    if board_state_list is None:
        return jsonify({"error": "Game not started."}), 400
    
    state = np.array(board_state_list, dtype=np.int8)

    # Validate and apply player's move
    valid_moves = game.get_valid_moves(state)
    if player_action is None or not (0 <= player_action < game.num_actions) or valid_moves[player_action] == 0:
        return jsonify({"error": "Invalid move."}), 400

    state = game.get_next_state(state, player_action)
    move_history.append(player_action)
    
    # Check for game over
    value, _ = game.get_value_and_terminated(state)
    is_terminal = game.check_game_over(state)
    winner = None
    status = "Ongoing"
    if is_terminal:
        status = "Game Over"
        if value == -1: # A win occurred
            # After a winning move, get_current_player returns the *next* player.
            # Therefore, the winner is the player who is NOT the current player.
            winner = "Player 2" if game.get_current_player(state) == 1 else "Player 1"
        else: # A draw
            winner = "Draw"

    # Store the new state and return
    session['board_state'] = state.tolist()
    session['move_history'] = move_history
    return jsonify({
        "board": session['board_state'],
        "status": status,
        "winner": winner,
        "move_history": session['move_history']
    })

# NEW ENDPOINT 2: Handles only the AI's move
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

    # Apply AI's move
    state = game.get_next_state(state, ai_action)
    move_history.append(ai_action)

    # Check for game over
    value, _ = game.get_value_and_terminated(state)
    is_terminal = game.check_game_over(state)
    winner = None
    status = "Ongoing"
    if is_terminal:
        status = "Game Over"
        if value == -1: # A win occurred
            # After a winning move, get_current_player returns the *next* player.
            # Therefore, the winner is the player who is NOT the current player.
            winner = "Player 2" if game.get_current_player(state) == 1 else "Player 1"
        else: # A draw
            winner = "Draw"

    session['board_state'] = state.tolist()
    session['move_history'] = move_history
    return jsonify({
        "board": session['board_state'],
        "status": status,
        "winner": winner,
        "move_history": session['move_history']
    })

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


@app.route('/api/game_status', methods=['GET'])
def game_status():
    """ Checks the current game status without making a move. """
    board_state_list = session.get('board_state')
    if board_state_list is None:
        # If there's no board in the session, the game hasn't started.
        return jsonify({
            "status": "Not Started",
            "winner": None
        })
    
    state = np.array(board_state_list, dtype=np.int8)

    # Use existing game logic to check for termination and winner
    value, _ = game.get_value_and_terminated(state)
    is_terminal = game.check_game_over(state)
    
    winner = None
    status = "Ongoing"

    if is_terminal:
        status = "Game Over"
        if value == -1:  # A win occurred for the last player
            # The winner is the player who is NOT the current player.
            winner_player_id = -game.get_current_player(state)
            winner = "Player 1" if winner_player_id == 1 else "Player 2"
        else:  # A draw
            winner = "Draw"
    
    return jsonify({
        "status": status,
        "winner": winner,
        "board": board_state_list,
        "move_history": session.get('move_history', [])
    })

@app.route('/api/preview_move', methods=['POST'])
def preview_move():
    """ Calculates the landing position of a move without making it. """
    data = request.get_json()
    action = data.get('column')

    board_state_list = session.get('board_state')
    if board_state_list is None:
        return jsonify({"error": "Game not started."}), 400
    
    state = np.array(board_state_list, dtype=np.int8)

    if action is None or not (0 <= action < game.num_actions):
        return jsonify({"error": "Invalid action."}), 400

    landing_position = game.get_landing_position(state, action)

    if landing_position is None:
        return jsonify({"error": "Column is full."}), 400

    player = game.get_current_player(state)

    # Convert numpy types to standard Python types for JSON serialization
    json_safe_landing_position = [int(coord) for coord in landing_position]

    return jsonify({
        "landing_position": json_safe_landing_position,
        "player": int(player)
    })

@app.route('/api/state_from_moves/', defaults={'moves_string': ''}, methods=['GET'])
@app.route('/api/state_from_moves/<string:moves_string>', methods=['GET'])
def get_state_from_moves(moves_string):
    """
    Calculates and returns a board state from a comma-separated string of moves.
    This now handles both empty and populated move strings.
    """
    try:
        moves = [int(move) for move in moves_string.split(',')] if moves_string else []
    except ValueError:
        return jsonify({"error": "Invalid move string. Moves must be comma-separated integers."}), 400

    state, applied_moves = game.get_state_from_moves(moves)
    
    response = {
        "board": state.tolist(),
        "moves_applied": applied_moves
    }
    
    if len(applied_moves) < len(moves):
        response["error"] = f"Invalid move '{moves[len(applied_moves)]}' for the board state. Displaying state before this move."
        return jsonify(response), 400

    return jsonify(response)


# --- 4. RUN THE APP ---

if __name__ == '__main__':
    # Use threaded=False to avoid issues with PyTorch model in multi-threaded context
    app.run(debug=True, threaded=False, port=5000)