# 🚀 Interactive 3D Connect Four AI 🤖

Welcome to the ultimate 3D Connect Four experience! This project brings the classic strategy game into a new dimension, allowing you to challenge two powerful AI opponents—a deep learning agent or a classic Minimax algorithm—directly in your web browser. Built with a Python/Flask backend and a dynamic Three.js frontend, this is more than just a game—it's an interactive showcase of modern AI.

![Gameplay GIF](https://i.imgur.com/example.gif)
*(Feel free to replace this image with a GIF of your own gameplay!)*

---

## ✨ Key Features

*   **Stunning 3D Gameplay:** Play Connect Four on a fully rendered and interactive 4x4x4 grid.
*   **Two Powerful AI Opponents:**
    *   **Neural Network AI:** Challenge an AI powered by a PyTorch ResNet model and a Monte Carlo Tree Search (MCTS) algorithm.
    *   **Minimax AI:** Play against a classic, formidable Minimax AI implemented in C++.
*   **Interactive Camera Controls:** Rotate, pan, and zoom around the board to view the game from any angle.
*   **Live Move Preview:** See exactly where your piece will land with a semi-transparent preview that appears as you hover over each column.
*   **Full Move History Navigation:**
    *   Use the **arrow keys** to step backward and forward through the game's move history.
    *   Instantly jump to any board position by pasting a sequence of moves (e.g., `1 3 12 15`) into the move history input box.
*   **Customizable Visuals:** Use the settings menu to adjust the size and opacity of the game pieces in real-time.
*   **State Management:** Copy the board state as a hex code or a list of moves to share or analyze positions.
*   **Web-Based:** No installation required for players! Just open a URL and start playing.

---

## 🛠️ Tech Stack

This project is a full-stack application combining a powerful backend for AI computation with a modern frontend for 3D visualization.
| Component | Technology                                                              | Description                                                      |
| :-------- | :---------------------------------------------------------------------- | :--------------------------------------------------------------- |
| 🧠 **Backend**  | **Python 3** with **Flask**                                             | Serves the web application and provides a REST API for gameplay. |
|           | **PyTorch**                                                             | Runs the pre-trained `ResNet3D` model for AI move evaluation.    |
|           | **NumPy**                                                               | Handles game state representation and logic efficiently.         |
|           | **C++ Executable**                                                      | A pre-compiled Minimax engine (`connect4_3D.exe`) for an alternative AI opponent. |
| ✨ **Frontend** | **JavaScript (ES6 Modules)**                                            | Manages game flow, user interactions, and API communication.     |
|           | **Three.js**                                                            | Renders the 3D board, pieces, and handles camera controls.       |
|           | **HTML5 / CSS3**                                                        | Structures the webpage and provides a clean, modern design.      |

---

## 🏗️ How It Works: Architecture Overview

The application is architected to provide a seamless user experience by separating the AI "thinking" from the user-facing interactions.

### 1. The Backend (The Brain 🧠)

The Flask server is the core of the application, responsible for:
*   **Loading the AI:** At startup, the server loads the trained PyTorch `ResNet3D` model into memory for fast access.
*   **Session Management:** It uses Flask sessions to keep track of the board state for each individual user, allowing multiple people to play simultaneously.
*   **API Endpoints:** It exposes a simple REST API:
    *   `POST /api/new_game`: Clears the session and creates a fresh 4x4x4 board.
    *   `POST /api/ai_move`: Triggers the PyTorch MCTS algorithm to compute its best move.
    *   `POST /api/minimax_move`: Calls the external C++ executable to get a move from the Minimax AI.
    *   `POST /api/set_state`: Allows the frontend to explicitly set the board state on the server, ensuring synchronization before an AI move.

### 2. The Frontend (The Experience ✨)

The frontend is a single-page application that handles all visuals and user input:
*   **3D Rendering:** `Three.js` is used to create the scene, including the 3D grid and the game pieces.
*   **Game Logic Mirroring:** A client-side version of the game logic (`gameLogic.js`) provides instant feedback for user moves and board state calculations (like generating hex codes).
*   **User Input:** A `Raycaster` detects which column the user clicks on or hovers over.
*   **Game Flow:**
    1.  When the user makes a move, the frontend updates the board state **locally** for an instant response.
    2.  To request an AI move, the user clicks either the "AI Move" or "Minimax Move" button.
    3.  The frontend first syncs its local state with the server using the `/api/set_state` endpoint.
    4.  It then calls the appropriate AI endpoint. A "thinking" message is displayed while the backend computes the move.
    5.  The board is updated with the AI's move upon receiving the response from the server.

---

## 🚀 Getting Started

Follow these steps to run the application on your local machine.

### Prerequisites

*   Python 3.8+
*   `pip` for installing Python packages
*   A trained PyTorch model file (`.pth`).
*   The compiled C++ Minimax executable (`connect4_3D.exe`).

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

    # Install the required packages from requirements.txt
    pip install -r requirements.txt
    ```

3.  **Place Project Binaries**
    *   **AI Model:**
        *   Ensure the `models` directory exists in the project root.
        *   Copy your trained model file into this directory and name it `model_best.pth`.
        *   The final path should be: `models/model_best.pth`.
    *   **Minimax Executable:**
        *   Ensure the `bin` directory exists in the project root.
        *   Place the `connect4_3D.exe` file inside it.
        *   The final path should be: `bin/connect4_3D.exe`.

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
├── bin/
│   └── connect4_3D.exe     # The C++ Minimax AI executable
├── models/
│   └── model_best.pth      # Your trained PyTorch model
├── static/
│   ├── css/
│   │   └── style.css       # Styles for the UI
│   └── js/
│       ├── gameLogic.js    # Client-side game logic for responsiveness
│       └── main.js         # The core Three.js and game flow script
├── templates/
│   └── index.html          # The main HTML page served to the user
├── ai_agent.py             # Contains ResNet, MCTS, and Node classes for the PyTorch AI
├── app.py                  # The main Flask server application
├── game_logic.py           # The backend ConnectFour3D game engine
├── requirements.txt        # Python package dependencies
└── README.md               # You are here!
```

---

## 🔮 Future Improvements

This project has a solid foundation, but there's always room for more features!
-   [ ] **Difficulty Levels:** Allow the user to select an AI difficulty (e.g., by changing the `num_simulations` for MCTS or search depth for Minimax).
-   [ ] **Player vs. Player Mode:** Implement a local hot-seat mode for two human players.
-   [ ] **Visual Enhancements:** Add piece-dropping animations and sound effects.
-   [ ] **Deployment:** Write instructions for deploying the app to a service like Heroku or DigitalOcean.
-   [ ] **Containerization:** Create a `Dockerfile` to make setup even easier.