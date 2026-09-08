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
*   **Column numbering.** Columns are 0–15; **Columns Start at 1** in the settings panel
    relabels them 1–16 for this tab. Display only — everything under the UI, puzzle files
    included, stays 0-based. See [`columnLabels.js`](static/js/columnLabels.js).
*   **Puzzle mode.** Tactical puzzles produced by the C++ engine, grouped into four
    difficulty categories and served instantly from a local bank while the engine keeps
    generating more in the background. See [Puzzle mode](#puzzle-mode).
*   **Live analysis.** A left-hand evaluation bar and a right-hand panel of ranked
    moves and expandable continuations. V3 deepens by two plies per iteration.
    See [Analysis mode](#analysis-mode).
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
*   `POST /api/analysis/start` - validate `{moves: [0..15, ...], top: 1..16}` and
    start a background V3 job; returns an opaque `job_id` (202).
*   `GET /api/analysis/<job_id>` - latest completed iteration and heartbeat.
*   `POST /api/analysis/<job_id>/stop` - cancel and release an analysis job.
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

## Analysis mode

Click **Analysis** to analyze the displayed position. The switch is personal to
this tab; the board and history still belong to the shared room. Exit Puzzle Mode
first. Automatic opponents are suspended while this tab is analyzing.

* The bar uses the same Light/Dark orange colors as the pieces. Positive values
    favor Light (X), negative values favor Dark (O), regardless of whose turn it is.
    Heuristic scores are **raw engine units**, not chess pawns or win probabilities.
    The bar uses a smooth, bounded visualization of these scores, not a calibrated
    probability model. `M<n>` is a proved win in n moves by the winner, not a promise
    of shortest mate; WDL-only proofs are labeled `L wins` / `D wins`.
* The **⚙** button in the panel's top-right corner opens the analysis settings; every
    analysis option lives there. It is personal to this tab and is not shared.
* **Best-move indicator** (on by default) marks the engine's current top move on the
    board with a slowly glowing bead in the colour of the side to move (a lightened cream
    for Light, Dark orange's own colour for Dark). It pulses rather than sitting still and
    never reaches full strength, so it reads as an annotation rather than as a played
    piece, and it never fades out completely either. The colour tracks the turn even when
    the same column stays best across a move. It follows the position on screen, not the position the
    engine was given: rewinding history or playing a move re-aims it, and it is hidden
    whenever there is nothing to point at (no completed iteration yet, a terminal
    position, or a column that is full in the displayed position).
* Choose 1, 3, 5, 8, or 16 top moves. All legal root moves are evaluated with full
    windows, then ranked for the **side to move**. Rows are never speculative
    alpha-beta bounds. Expand a row for the continuation and a **Play column** button.
    Columns are numbered exactly like move history. Lines may be shorter than
    the search depth when a tactical result or transposition-table cutoff ends them.
* The search retains its transposition table while deepening through **2, 4, 6,
    … plies**. Only completed iterations are published, preventing partly searched
    root moves from being compared at different depths. Two-ply increments reduce
    parity oscillation but cannot eliminate legitimate evaluation changes.
* Use arrow keys or the four history-navigation buttons to analyze earlier
    positions. Playing a move while reviewing replaces the future history on the
    **shared board**, creating a new continuation. Merely expanding a line does not
    change the board. Remote moves, undo, reset, and imported histories restart
    analysis; stale results never replace the new position's evaluation.
* **Pause** frees the engine and retains the last completed evaluation. **Resume**
    starts a new search. Hiding a tab suspends its search; returning restarts it.
    Terminal positions have no candidate rows. Searching finishes once all root
    values are proved, depth 64 is reached, or the 30-minute safety limit expires.

Implementation: [analysis.py](analysis.py) owns short-lived job snapshots and
background subprocess readers; [static/js/analysis.js](static/js/analysis.js)
polls every 700 ms without holding Flask's single HTTP worker. Each job owns a
64 MiB TT. At most two engines run per server process; additional requests get a
clear 429 response. Engines run below normal priority on Windows. A 20-second
heartbeat lease kills abandoned jobs (including interrupted start requests).
These limits are per Flask process; multi-process hosting would need shared job
routing. Existing synchronous neural/minimax requests can still delay HTTP
responses; analysis itself does not block the request thread.

Build and deploy using the sibling engine's [build script](../connect4-c++/build.ps1)
with `-Tests -DeployWeb`, then restart Flask. The executable protocol is
`analyze <comma-separated-history-or-dash> <top> [maxDepth] [milliseconds]` and
emits one flushed JSON object per line (`iteration`, `terminal`, `done`).
Tests: `python -m unittest test_analysis test_puzzle_bank -v`; the engine integration
tests require a deployed analysis-capable executable. The C++ V3 suite also checks
even-depth publication, both score orientations, and legal continuations.

---

## Puzzle mode

A puzzle has exactly one winning move, or exactly one drawing move when every other
move loses. Each solver turn in the recorded line is verified by exact V3 proofs.
The opponent reply is selected to expose another unique decision. Lines can finish
before actual mate; they never ask an ambiguous or unverified solver decision.

Categories now measure **actual playable decisions**, not theoretical mate distance:
Quick 1–3, Medium 4–5, Long 6–11, Endgame 12+. Legacy mate labels remain metadata;
V3 records have `mate=null`, `steps`, and `goal=win|draw` in the API. Existing puzzle
files are not rewritten or deleted by the background worker.

*   **Solving.** Click the column of the winning/drawing move. The opponent's reply plays
    automatically; wrong moves are rejected so you can retry. There are buttons to reset
    the position, play out the solution, and fetch another puzzle in the same category.
    The move-history panel stays available, so a position can be copied out for analysis.
*   **Where puzzles come from.** V3 samples quiet legal 26–28-piece positions, proves
    uniqueness using win/draw threshold searches, and builds the longest verified
    continuation found within its budget. It does not optimize mate distance.
    Versioned records are appended to `puzzles/generated_v3.jsonl`, with symmetry-
    canonical identities for deduplication. Interrupted final records are ignored.
*   **Background generation.** While the puzzle UI is open, the engine generates and
    verifies puzzles in short batches:
    ```
    bin/connect4_3D.exe genpuzzle 2 400 <outputDir> 30 26 28 2
    ```
    Defaults: 30-second batches, 2 seconds total per candidate including continuation,
    at least two playable solver moves, one below-normal-priority Windows process.
    Configure `PUZZLE_SEEDS`, `PUZZLE_BATCH_SECONDS`, `PUZZLE_CANDIDATE_SECONDS`
    (maximum 120), and `PUZZLE_MIN_STEPS` before starting Flask. Set longer batch and
    candidate budgets together when mining harder puzzles. Leaving puzzle mode kills
    the process immediately; a batch also has a five-second external timeout grace.
    Build/deploy from the C++ folder with `build.ps1 -Tests -DeployWeb`; see the
    sibling engine's [pipeline report](../connect4-c++/PUZZLES_V3.md) for guarantees
    and measured throughput. Restart Flask after updating Python code.
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
│   ├── css/analysis.css
│   ├── js/
│   │   ├── analysis.js     # analysis panel, engine request loop
│   │   ├── columnLabels.js # 0- vs 1-based column numbering, display side only
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
