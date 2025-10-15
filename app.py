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
    'num_simulations': 50, # Number of MCTS simulations for AI move
    'num_resBlocks': 20,
    'num_hidden': 512,
    # Add other args if your MCTS needs them (e.g., dirichlet)
    'dirichlet_epsilon': 0.25,
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
    return jsonify({
        "message": "New game started!",
        "board": session['board_state']
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
    if board_state_list is None:
        return jsonify({"error": "Game not started."}), 400
    
    state = np.array(board_state_list, dtype=np.int8)

    # Validate and apply player's move
    valid_moves = game.get_valid_moves(state)
    if player_action is None or not (0 <= player_action < game.num_actions) or valid_moves[player_action] == 0:
        return jsonify({"error": "Invalid move."}), 400

    state = game.get_next_state(state, player_action)
    
    # Check for game over
    value, is_terminal = game.get_value_and_terminated(state)
    winner = None
    status = "AI Thinking" # New status to let the frontend know to call the AI
    if is_terminal:
        status = "Game Over"
        winner = "Player" if value == -1 else "Draw"

    # Store the new state and return
    session['board_state'] = state.tolist()
    return jsonify({
        "board": session['board_state'],
        "status": status,
        "winner": winner
    })

# NEW ENDPOINT 2: Handles only the AI's move
@app.route('/api/ai_move', methods=['POST'])
def ai_move():
    """ Takes the current board state and computes the AI's response. """
    if model is None:
        return jsonify({"error": "AI Model is not loaded!"}), 500

    # Retrieve the board state (which now includes the player's last move)
    board_state_list = session.get('board_state')
    if board_state_list is None:
        return jsonify({"error": "Game not started."}), 400
    
    state = np.array(board_state_list, dtype=np.int8)

    # --- AI's Move ---
    ai_action_probs = mcts.search(state)
    ai_action = int(np.argmax(ai_action_probs))

    # Apply AI's move
    state = game.get_next_state(state, ai_action)

    # Check for game over
    value, is_terminal = game.get_value_and_terminated(state)
    winner = None
    status = "Ongoing"
    if is_terminal:
        status = "Game Over"
        winner = "AI" if value == -1 else "Draw"

    session['board_state'] = state.tolist()
    return jsonify({
        "board": session['board_state'],
        "status": status,
        "winner": winner
    })


# --- 4. RUN THE APP ---

if __name__ == '__main__':
    # Use threaded=False to avoid issues with PyTorch model in multi-threaded context
    app.run(debug=True, threaded=False, port=5000)