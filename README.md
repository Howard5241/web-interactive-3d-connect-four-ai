# 🚀 Interactive 3D Connect Four AI 🤖

Welcome to the ultimate 3D Connect Four experience! This project brings the classic strategy game into a new dimension, allowing you to challenge a powerful deep learning AI opponent directly in your web browser. Built with a Python/Flask backend and a dynamic Three.js frontend, this is more than just a game—it's an interactive showcase of modern AI.


*(Feel free to replace this image with a GIF of your own gameplay!)*

---

## ✨ Key Features

*   **Stunning 3D Gameplay:** Play Connect Four on a fully rendered 4x4x4 grid.
*   **Powerful AI Opponent:** Challenge an AI powered by a PyTorch ResNet model and a Monte Carlo Tree Search (MCTS) algorithm.
*   **Interactive Camera Controls:** Rotate, pan, and zoom around the board to view the game from any angle.
*   **Live Move Preview:** See exactly where your piece will land with a semi-transparent preview that appears as you hover over each column.
*   **Customizable Visuals:** Use the settings menu to adjust the size and opacity of the game pieces to your liking.
*   **Full Move History Navigation:** Step backward and forward through the game's move history using the arrow keys to review the entire match.
*   **Load Game State:** Instantly jump to any board position by pasting a sequence of moves into the move history input box.
*   **Responsive UI:** Your moves appear instantly on the board, providing a smooth and satisfying user experience.
*   **Web-Based:** No installation required for players! Just open a URL and start playing.

---

## 🛠️ Tech Stack

This project is a full-stack application combining a powerful backend for AI computation with a modern frontend for 3D visualization.
| Component | Technology                                                              | Description                                                      |
| :-------- | :---------------------------------------------------------------------- | :--------------------------------------------------------------- |
| 🧠 **Backend**  | **Python 3** with **Flask**                                             | Serves the web application and provides a REST API for gameplay. |
|           | **PyTorch**                                                             | Runs the pre-trained `ResNet3D` model for AI move evaluation.    |
|           | **NumPy**                                                               | Handles game state representation and logic efficiently.         |
| ✨ **Frontend** | **JavaScript (ES6 Modules)**                                            | Manages game flow, user interactions, and API communication.     |
|           | **Three.js**                                                            | Renders the 3D board, pieces, and handles camera controls.       |
|           | **HTML5 / CSS3**                                                        | Structures the webpage and provides a clean, modern design.      |

---

## 🏗️ How It Works: Architecture Overview

The application is architected to provide a seamless user experience by separating the AI "thinking" from the user-facing interactions.

### 1. The Backend (The Brain 🧠)

The Flask server is the core of the application, responsible for:
*   **Loading the AI:** At startup, the server loads the trained PyTorch `ResNet3D` model into memory for fast access.
*   **Session Management:** It uses Flask sessions to keep track of the board state for each individual user, allowing multiple people to play simultaneously without interfering with each other.
*   **API Endpoints:** It exposes a simple REST API:
    *   `POST /api/new_game`: Clears the session and creates a fresh 4x4x4 board.
    *   `POST /api/player_move`: Receives the player's move, validates it, updates the board, and returns the new state.
    *   `POST /api/ai_move`: Triggers the MCTS algorithm to compute the AI's best move based on the current board state and returns the final state.
    *   `POST /api/set_state`: Explicitly sets the board state and move history, used to sync the frontend with the backend.
    *   `GET /api/game_status`: Returns the current board, move history, and game status (ongoing, win, draw).

### 2. The Frontend (The Experience ✨)

The frontend is a single-page application that handles all visuals and user input:
*   **3D Rendering:** `Three.js` is used to create the scene, including the 3D grid and the game pieces (spheres).
*   **Camera Controls:** The `OrbitControls` addon allows the user to intuitively drag to rotate, right-drag to pan, and scroll to zoom.
*   **User Input:** A `Raycaster` detects which column the user clicks on or hovers over.
*   **Settings Modal:** A pop-up window allows the user to customize the piece size and opacity in real-time.
*   **Responsive Game Flow:** The game flow is designed to be interactive and give the user control.
    1.  When the user clicks a column, the frontend updates the board state **locally** for an instant response.
    2.  The game then waits for the user's next action. The user can click the "AI Move" button to have the AI play its turn.
    3.  When the AI move is requested, the frontend first syncs its local state with the server.
    4.  A "thinking" message is displayed while the backend computes the move. The board is updated upon completion.

---

## 🚀 Getting Started

Follow these steps to run the application on your local machine.

### Prerequisites

*   Python 3.8+
*   `pip` for installing Python packages
*   A trained PyTorch model file (`.pth`) from your original project.

### Installation & Setup

1.  **Clone the Repository**
    ```bash
    git clone https://your-repository-url.com/connect4-web-app.git
    cd connect4-web-app
    ```

2.  **Set up the Python Environment**
    It's highly recommended to use a virtual environment.
    ```bash
    # Create and activate a virtual environment
    python -m venv venv
    source venv/bin/activate  # On Windows, use `venv\Scripts\activate`

    # Install the required packages
    pip install -r requirements.txt
    ```
    *(Note: Create a `requirements.txt` file with the content: `Flask`, `torch`, `numpy`)*

3.  **Place the AI Model**
    *   Create a directory named `models` in the project root.
    *   Copy your trained model file into this directory and rename it to `model_best.pth`.
    *   The final path should be: `models/model_best.pth`.

4.  **Run the Application**
    *   Start the Flask server from the root directory:
        ```bash
        flask run
        ```
    *   You should see output indicating the server is running on `http://127.0.0.1:5000` and that the model was loaded successfully.

5.  **Play!**
    *   Open your web browser and navigate to **http://127.0.0.1:5000**.
    *   Click "New Game" and make your first move!

---

## 📁 Project Structure

```
/connect4-web-app/
├── models/
│   └── model_best.pth      # Your trained PyTorch model
├── static/
│   ├── css/
│   │   └── style.css       # Styles for the info panel
│   └── js/
│       └── main.js         # The core Three.js and game logic script
├── templates/
│   └── index.html          # The main HTML page served to the user
├── ai_agent.py             # Contains ResNet, MCTS, and Node classes
├── game_logic.py           # Contains the ConnectFour3D game engine
├── app.py                  # The main Flask server application
└── README.md               # You are here!
```

---

## 🔮 Future Improvements

This project has a solid foundation, but there's always room for more features!
-   [ ] **Difficulty Levels:** Allow the user to select an AI difficulty (e.g., by changing the `num_simulations` for MCTS).
-   [ ] **Player vs. Player Mode:** Implement a local hot-seat mode for two human players.
-   [ ] **Visual Enhancements:** Add piece-dropping animations and sound effects.
-   [ ] **Deployment:** Write instructions for deploying the app to a service like Heroku or DigitalOcean.
-   [ ] **Containerization:** Create a `Dockerfile` to make setup even easier.