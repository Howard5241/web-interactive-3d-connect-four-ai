# 3D Connect Four (web app)

Connect Four on a 4x4x4 grid, played in the browser. A Flask backend serves a three.js
board and provides two opponents: a PyTorch ResNet + MCTS agent, and the C++ minimax
engine from `connect4-c++/`. There is also a puzzle mode backed by an engine-generated
puzzle bank, and a shared-room mode so several browsers can look at and play the same
board.

![Gameplay Demo](./assets/gamePlay.gif)

---

## Features

*   **3D board.** 4x4x4 grid rendered with three.js, with orbit/pan/zoom camera
    controls. Pieces use an FBX model (`static/models/Piece.fbx`), falling back to
    spheres if it fails to load.
*   **Two opponents.**
    *   Neural network: a `ResNet3D` policy/value network (10 residual blocks, 128
        channels, ~9.0M parameters) searched with MCTS at 500 simulations per move.
        The architecture is read out of the checkpoint at startup, so swapping in a
        differently-shaped `.pth` does not need a code change.
    *   Minimax: the prebuilt C++ engine `bin/connect4_3D.exe`, driven over stdin.
    *   Either can be set to move automatically after yours, from the settings panel.
*   **Move preview and planning ghosts.** Hovering a column shows where the piece will
    land. Right-clicking a column places a translucent planning piece; right-clicking
    empty space clears them.
*   **History navigation.** Arrow keys step through the game. Pasting a move list
    (e.g. `1 3 12 15`) into the move-history box jumps to that position. There is an
    undo button, and buttons to copy the position as a move list or as a hex board code.
*   **Visual settings.** Piece size and opacity, drop-animation toggle, and two
    occlusion aids: an outline ring drawn where a piece is hidden behind another, and a
    mask that dims the occluding piece. Both are adjustable down to off.
*   **Puzzle mode.** Tactical puzzles produced by the C++ engine, grouped into four
    difficulty categories and served instantly from a local bank while the engine keeps
    generating more in the background. See [Puzzle mode](#puzzle-mode).
*   **Shared rooms.** The board lives on the server, not in one browser, so everyone on
    the page sees the same game. See [Shared rooms](#shared-rooms).

---

## Tech stack

| Component | Technology | Role |
| :-------- | :--------- | :--- |
| Backend  | Python 3.11 + Flask 3.1 | Serves the page and the REST API. |
|          | PyTorch 2.9 (CUDA if available) | Runs the `ResNet3D` checkpoint for the MCTS agent. |
|          | NumPy | Board representation and game rules. |
|          | `bin/connect4_3D.exe` | C++ minimax engine; also generates puzzles via its `genpuzzle` CLI. |
| Frontend | JavaScript (ES modules) | Game flow, input, API calls, room sync. |
|          | three.js 0.160 (unpkg CDN, via import map) | Rendering, camera, FBX loading. Needs network access on first load. |
|          | HTML5 / CSS3 | Page structure and UI. |

---

## Architecture

### Backend

`app.py` loads the model once at startup, loads the puzzle bank from `puzzles/`, and
creates the room registry. It runs single-threaded (`threaded=False`) because the
PyTorch model and the engine subprocess are shared, unsynchronised state.

Endpoints:

*   `POST /api/new_game` - reset the board in the Flask session.
*   `POST /api/ai_move` - run MCTS on the session's board and return the chosen column.
*   `POST /api/minimax_move` - hand two hex board codes to the C++ engine and parse its
    move out of stdout.
*   `POST /api/set_state` - set the session's board and move history, used to sync
    before asking for an AI move.
*   `GET /api/room/state` - poll a room for changes; doubles as the presence heartbeat.
*   `POST /api/room/state` - push a partial state patch to a room.
*   `POST /api/room/leave` - drop a viewer from the presence list on tab close.
*   `GET /api/puzzle?category=<quick|medium|long|endgame>` - a random puzzle from that
    category, skipping ones recently served to this session. `?mate=<k>` still works for
    a single mate length.
*   `GET /api/puzzle/counts` - puzzles available per mate length and per category, plus
    the category definitions.
*   `POST /api/puzzle/generate/start` / `stop`, `GET /api/puzzle/generate/status` -
    control and poll background puzzle generation.

### Frontend

`static/js/main.js` is the whole client: scene setup, input handling, game flow, puzzle
mode and settings. `gameLogic.js` mirrors the rules client-side, so a human move renders
immediately without a round trip and hex codes can be computed locally. `sync.js`
implements the room protocol.

A local move is applied on screen first, then pushed to the room. Asking for an engine
move syncs the board to the server with `/api/set_state`, claims the engine lock, calls
the relevant endpoint, and releases the lock when the move comes back.

---

## Shared rooms

`room_state.py` (server) and `static/js/sync.js` (client) keep every browser on the site
looking at one board. The shared state is the move list, which move is being viewed, the
planning ghosts, puzzle mode and its progress, plus an engine lock.

*   **Presence.** Each tab gets an id in `sessionStorage` and is listed as "Guest N" with
    a colour. Two tabs of one browser count as two viewers. Viewers that stop polling for
    12 seconds are dropped.
*   **Conflicts.** Anything that adds a move is pushed with the version it was based on.
    If someone else moved first, the push is rejected with 409 and the client resyncs
    rather than both moves landing.
*   **Engine lock.** While one viewer has an engine running, the others see who is
    thinking and their AI buttons are disabled. The lock is released if that tab
    disappears, and expires after 180 seconds regardless.
*   **Shared log.** The Game Log panel is shared, so everyone sees what the others did.
*   **Rooms.** Everyone shares the room `main` by default; `?room=<name>` in the URL gives
    a group its own board. Up to 64 rooms are kept, oldest idle room reclaimed first.

Transport is polling (about 0.4s when the tab is visible, 2.5s when it is hidden) rather
than websockets, because the single-threaded dev server has only one worker and a
long-lived stream would occupy it.

---

## Puzzle mode

A puzzle is a position that is objectively mate-in-k for the side to move. The line you
play is truncated so you are never shown a position with more than one winning move: it
continues only while your move is the single winning move, and stops at the first branch.
So a mate-in-8 whose only forced-unique move is the first is a one-move puzzle, still
filed under mate 8. The mate distance decides the category but is not shown to the
player.

| Category | Mate distance | In the bank |
| :-- | :-- | --: |
| Quick win | 1-3 | 22,395 |
| Medium win | 4-5 | 447 |
| Long win | 6-11 | 265 |
| Endgame | 12+ | 221 |

Counts are the current contents of `puzzles/` (23,328 total, deduplicated on load).
The distribution is heavily skewed: mate-in-1 alone is 18,922 of them, while the longest
buckets hold a few dozen each. Deep forced wins are rare and slow to verify, so those
categories grow slowly.

*   **Solving.** Click the column of the winning move. The opponent's forced reply plays
    automatically; wrong moves are rejected so you can retry. There are buttons to reset
    the position, play out the solution, and fetch another puzzle in the same category.
    The move-history panel stays available, so a position can be copied out for analysis.
*   **Where puzzles come from.** The engine's generator plays the optimal line to the real
    mate to get the objective distance k, then truncates the recorded solution at the
    first position where more than one move wins, decided by a full exact solve rather
    than a forcing-search shortcut. Results are stored in `puzzles/mate_in_<k>.txt` and
    loaded into an in-memory bank at startup. (The engine's `truncatepuzzles` CLI applies
    the same rule to an existing bank.)
*   **Background generation.** While the puzzle UI is open, the engine generates and
    verifies puzzles in short batches:
    ```
    bin/connect4_3D.exe genpuzzle 1 40 <outputDir> 12 <minPieces> <maxPieces>
    ```
    Each batch keeps every mate length at once. Seed piece-counts rotate through windows
    inside 26-32 pieces (32-38 empty cells), which keeps candidates on emptier boards
    where the interesting positions are, at the cost of slower exact solves. New puzzles
    are appended, the bank reloads, and the files are rewritten deduplicated every fifth
    batch. Generation can be paused from the UI, and leaving puzzle mode kills the current
    batch immediately so the engine is free for the minimax opponent.
*   **File puzzles.** "Load from File" accepts `.txt` puzzle files in either the 2-line
    (`history` / `solution`) or the engine's 3-line (`board code` / `history` / `solution`)
    format.

---

## Running it locally

### Prerequisites

*   Python 3.11 with `flask`, `torch` and `numpy`. In this checkout the environment lives
    outside the repo at `..\venv` (see the top-level `CLAUDE.md`).
*   `models/model_best.pth` - the trained checkpoint. It is gitignored, so it has to be
    copied in.
*   `bin/connect4_3D.exe` - build it from `connect4-c++/`, or copy an existing build.

### Start the server

```powershell
& "C:\Users\Howard\Desktop\Work\venv\Scripts\python.exe" app.py
```

Run `app.py` directly rather than `flask run`: the entry point sets `threaded=False`,
which the shared model and engine subprocess depend on. Startup prints the device, the
architecture detected in the checkpoint, and the puzzle-bank counts. Then open
<http://127.0.0.1:5000>.

`requirements.txt` is a full freeze of the shared environment, not a minimal dependency
list; the app itself only needs flask, torch and numpy.

---

## Project structure

```
/connect4-web-app/
├── bin/
│   └── connect4_3D.exe     # C++ minimax engine; also the puzzle generator
├── models/
│   └── model_best.pth      # trained PyTorch checkpoint (gitignored)
├── puzzles/                # puzzle bank, mate_in_<k>.txt
├── static/
│   ├── css/style.css
│   ├── js/
│   │   ├── gameLogic.js    # client-side rules mirror
│   │   ├── main.js         # scene, input, game flow, puzzle mode, settings
│   │   └── sync.js         # room protocol, client half
│   └── models/Piece.fbx    # piece mesh
├── templates/index.html
├── ai_agent.py             # ResNet3D, MCTS, Node
├── app.py                  # Flask server and API
├── game_logic.py           # backend ConnectFour3D rules
├── puzzle_bank.py          # puzzle bank + background generation manager
├── room_state.py           # shared room state, presence, engine lock
└── requirements.txt
```

---

## Status and limitations

*   Development setup only. It runs on the Flask dev server with `debug=True`, a
    hard-coded secret key, and no authentication; the room state is in memory and is lost
    on restart.
*   Room state is not persisted and rooms have no access control. Anyone who knows the
    URL can move in a room.
*   AI strength is fixed: 500 MCTS simulations, and whatever depth the minimax engine
    picks on its own.
*   Puzzle coverage is thin above mate-in-5, and generation is slow to improve it.
*   Three.js is loaded from a CDN, so the first load needs internet access.

## Not done yet

-   [ ] Selectable difficulty (MCTS simulation count, minimax depth).
-   [ ] Turn ownership in shared rooms, so two people can be assigned the two colours
        instead of anyone moving for either side.
-   [ ] Persisting room state and puzzle progress across restarts.
-   [ ] Sound effects.
-   [ ] A deployment path off the dev server (production WSGI server, pinned
        requirements, Dockerfile).
