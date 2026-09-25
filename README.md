# 3D Connect Four (web app)

Connect Four on a 4x4x4 grid, played in the browser. A Flask backend serves a three.js
board and provides two opponents: a PyTorch ResNet + MCTS agent, and the C++ minimax
engine from `connect4-c++/`. The minimax engine and analysis mode run **in the browser**,
as a WebAssembly build of that engine, the way chess sites run their engine locally for
self-analysis. There is also a puzzle mode backed by an engine-generated
puzzle bank, and a shared-room mode so several browsers can look at and play the same
board.

![Gameplay Demo](./assets/gamePlay.gif)

---

## Features

*   **3D board.** 4x4x4 grid rendered with three.js, with orbit/pan/zoom camera
    controls. Pieces use an FBX model (`static/models/Piece.fbx`), falling back to
    spheres if it fails to load. The light side is glazed clay and the dark side oak
    veneer, textured from `static/textures/` — see [Piece textures](#piece-textures).
*   **Two opponents.**
    *   Neural network: a `ResNet3D` policy/value network (10 residual blocks, 128
        channels, ~9.0M parameters) searched with MCTS at 500 simulations per move.
        The architecture is read out of the checkpoint at startup, so swapping in a
        differently-shaped `.pth` does not need a code change.
    *   Minimax: the C++ Strong V4 engine, compiled to WebAssembly and run in a Web
        Worker in your browser (3 seconds per move). See [Browser engine](#browser-engine).
    *   Either can be set to move automatically after yours, from the settings panel.
*   **Move preview and planning ghosts.** Hovering a column shows where the piece will
    land. Right-clicking a column places a planning piece; right-clicking empty space
    clears them. A ghost is the same solid, full-size bead as a real piece and is told
    apart by colour alone: the two ghosts are light and dark orange, which reads as an
    annotation because the pieces themselves are white clay and brown oak.
*   **Ghost lines.** Right-press one piece and release on another and, if a four-in-a-row
    runs through both, the whole run is drawn from end to end — including the cells nobody
    has played yet. Repeating a drag takes that line down again. Only a drag traces a
    line — a right-*click* stays an ordinary right-click even when it lands on a piece,
    since the ray to the top of a pole very often clips a bead further down. The camera
    stays put for the duration of a drag, and the lines are shared and cleared exactly
    like the planning ghosts.
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
    moves and expandable continuations. V4 searches every depth; displayed evals
    use even depths for Light and odd depths for Dark.
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
|          | `bin/connect4_3D.exe` | C++ engine; generates puzzles via its `genpuzzle` CLI. |
| Frontend | JavaScript (ES modules) | Game flow, input, API calls, room sync. |
|          | `static/engine/` (WebAssembly) | The same C++ engine, run in a Web Worker for analysis and the minimax opponent. |
|          | three.js 0.160 (unpkg CDN, via import map) | Rendering, camera, FBX loading. Needs network access on first load. |
|          | HTML5 / CSS3 | Page structure and UI. |

---

## Architecture

### Backend

`app.py` loads the model once at startup, loads the puzzle bank from `puzzles/`, and
creates the room registry. It runs single-threaded (`threaded=False`) because the
PyTorch model and the puzzle generator's engine subprocess are shared, unsynchronised
state. The server does not run analysis or minimax searches; browsers do.

Endpoints:

*   `POST /api/new_game` - reset the board in the Flask session.
*   `POST /api/ai_move` - run MCTS on the session's board and return the chosen column.
*   `POST /api/set_state` - set the session's board and move history, used to sync
    before asking for an AI move.
*   `GET /api/room/state` - poll a room for changes; doubles as the presence heartbeat.
*   `POST /api/room/state` - push a partial state patch to a room.
*   `POST /api/room/leave` - drop a viewer from the presence list on tab close.
*   `GET /api/puzzle?category=<quick|medium|long|endgame>` - a random puzzle from that
    category, skipping ones recently served to this session. `?mate=<k>` still works for
    a single mate length. Categories group by the objective mate length in solver moves
    (1-3, 4-5, 6-11, 12+), not by how long the recorded line happens to be.
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
move claims the engine lock, gets the move, and releases the lock when it comes back.
The neural opponent syncs the board to the server with `/api/set_state` and calls
`/api/ai_move`; the minimax opponent searches in this browser (`engine.js`).

### Browser engine

`static/engine/connect4_engine.{js,wasm}` is the C++ engine compiled to WebAssembly
(about 200 KB). [`static/js/engine.js`](static/js/engine.js) runs it in a module Web
Worker ([`engineWorker.js`](static/js/engineWorker.js)) so a search never blocks the
page, and exposes two calls:

*   `analyze(moves, onSnapshot)` - the engine's `analyze` command. Each completed
    iteration arrives as a snapshot for the analysis panel; the handle it returns
    cancels the search.
*   `bestMove(moves)` - the engine's `bestmove` command: the Strong V4 bot with a
    3-second limit, as the Playground plays it.

A search is one synchronous call inside the worker, so cancelling terminates the
worker and the next request starts a fresh one. One worker serves the tab, and a new
request cancels the running one. The engine reports the same depths and scores as a
native build, at roughly 1.2–1.4x the time (WebAssembly has no AVX2, so it uses the
engine's scalar code). Each search allocates a 64 MiB table, so the tab uses around
100 MB more memory while analyzing.

To rebuild after changing the engine, install
[Emscripten](https://emscripten.org/docs/getting_started/downloads.html) and run the
engine repo's `./build.ps1 -Wasm -DeployWeb` (Windows) or
`./build_wasm.sh <path-to-this-repo>` (Linux/macOS). Both copy the two files into
`static/engine/`. Flask serves `.wasm` as `application/wasm`, which browsers need to
compile it while it downloads.

---

## Shared rooms

`room_state.py` (server) and `static/js/sync.js` (client) keep every browser on the site
looking at one board. The shared state is the move list, which move is being viewed, the
planning ghosts, the ghost lines, puzzle mode and its progress, plus an engine lock.

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
    probability model. **`M<n>` is an exact mate distance** once refinement is
    certified: the winner mates as quickly as possible and the defender delays
    as long as possible, conditional on the row's root move being played.
    `n` counts moves by the winner; hover for the exact number of plies, including
    that root move. `−M<n>` favors Dark. **`≈M<n>` is provisional**: the outcome
    is proved but shortest-mate refinement has not finished. WDL-only proofs
    remain `L wins` / `D wins`; proved draws are labeled `Draw`.
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
    alpha-beta bounds. Expand a row for the continuation and its two play buttons.
    Columns are numbered exactly like move history. Lines may be shorter than
    the search depth when a tactical result or transposition-table cutoff ends them.
* **Play column** plays that one move. **Play line (n moves)** plays the whole
    continuation — both sides — onto the shared board in one step, with no drop
    animation, the same as any other multi-move change. It appears only when the line
    is longer than one move, since a one-move line is what the first button already
    does. Both replace the future history when you are reviewing an earlier position,
    and both push once, so another viewer moving first is still detected. A line stops
    at the move that ends the game rather than running past it; if the rest of a line
    cannot be played from the position on screen, what did play is kept and the log
    says so.
    Because every column is valued anyway, this setting is **display only**: changing
    it re-ranks the rows already on screen and never restarts the search, so a running
    analysis keeps its table, its depth and any proof progress. The engine always
    reports all sixteen ranked rows; the panel draws as many as it is set to show.
* The search retains its transposition table while deepening through **1, 2, 3,
    … plies**. The panel keeps completed **even depths (2, 4, 6, …) for Light's
    turn** and **odd depths (1, 3, 5, …) for Dark's turn** for display. This keeps
    the nominal leaf side consistent across turns. Fully proved results and game
    over are always shown, even if the engine stops on the other parity. Filtering
    reduces parity oscillation but cannot eliminate legitimate evaluation changes.
* The engine is the **balanced V4 solver** (arena id `v4-balanced`): gravity-aware
    ordering in the exact search, plus one bounded win/draw/loss proof attempt after
    depth 8 once the board holds 22 or more stones. That attempt gets half the
    remaining clock. If it succeeds, the panel jumps straight from depth 8 to proved
    values for every column; if it does not, ordinary deepening resumes at depth 9
    having spent that half. Depth therefore appears to stall at 8 for the duration
    of the attempt — the search is running, not stuck.
* After **all root outcomes are proved**, analysis automatically spends the
    remaining clock finding **exact mate distances**. The panel says
    “Outcomes proved · finding exact mate distances.” Each completed root-move
    distance appears immediately; unresolved rows keep their proved outcome.
    Root ordering is provisional during this phase, then sorted by optimal
    distance when all rows are finished. Draws do not need a mate search.
    This extra step uses a separately tagged exact-distance TT in the same
    64 MiB allocation: shallow scores and WDL-only proofs are never mistaken for
    distance values. No heuristic leaves or WDL-only tempo/sterile reductions
    are used to certify distance. A PV can still be shorter than the mate
    distance; its length is not used to calculate the result.
* Use arrow keys or the four history-navigation buttons to analyze earlier
    positions. Playing a move while reviewing replaces the future history on the
    **shared board**, creating a new continuation. Merely expanding a line does not
    change the board. Remote moves, undo, reset, and imported histories restart
    analysis; stale results never replace the new position's evaluation.
* **Pause** stops the engine and retains the last completed evaluation. **Resume**
    starts a new search. Hiding a tab suspends its search; returning restarts it.
    Terminal positions have no candidate rows. Searching finishes when all root
    distances (or draws) are resolved, or the 30-minute safety limit expires.
    A pause/timeout during refinement keeps the WDL results and every distance
    already completed; it never fabricates a distance for unfinished rows.

Analysis runs entirely in this tab's browser engine (see [Browser engine](#browser-engine)),
so it costs the server nothing, works for any number of viewers at once, and keeps
running if the server is busy. [static/js/analysis.js](static/js/analysis.js) owns the
panel; `engine.js` folds the engine's output into the snapshots it draws. The
engine's `analyze` command emits one JSON object per line (`iteration`, `terminal`,
`done`) and is the same code as the native executable's
`analyze <comma-separated-history-or-dash> <top> [maxDepth] [milliseconds]`.
Iterations include `phase` (`search`, `mate`, `complete`) and `mate_complete`.
`complete` retains its original meaning of all outcomes being proved; it does
not by itself mean mate refinement finished. Rows include `mate_exact` and
nullable `mate_plies`; a WDL score of +/-30000 is **not** mate in zero.
Tests: `node --test tests/engine.test.mjs` checks the worker protocol (depth parity,
errors, cancellation) against a fake worker, then loads the real WebAssembly engine to
check ranked rows at every depth, terminal positions, immediate wins and blocks, the
minimax time limit, and exact mate distances against an exhaustive oracle.
`python -m unittest test_puzzle_bank -v` covers the puzzle bank. The C++ V3 suite also checks
every-depth publication, both score orientations, and legal continuations.
The separate C++ mate-distance suite compares every root move against exhaustive
DTM minimax on 300 positions, including forced losses, draws, cold/warm/color-swapped
tables, and interrupted refinement. Serve [tests/analysis_panel.html](tests/analysis_panel.html)
from this directory for renderer assertions without loading the neural model.

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
    continuation found within its budget. Length is counted in decisions: a solver
    move that only answers an immediate threat does not lengthen the line it is
    ranked on, so a shorter line of real choices beats a longer forced one. It does
    not optimize mate distance.
    Versioned records are appended to `puzzles/generated_v3.jsonl`, with symmetry-
    canonical identities for deduplication. Interrupted final records are ignored.
*   **Background generation.** While the puzzle UI is open, the engine generates and
    verifies puzzles in short batches:
    ```
    bin/connect4_3D.exe genpuzzle 2 400 <outputDir> 30 26 28 2
    ```
    The engine's own CLI defaults are 30-second batches and 2 seconds total per
    candidate including continuation; the app asks for more: 400 seeds, 180-second
    batches, 30 seconds per candidate and a 45-second distance allowance, with at
    least two playable solver moves, in one below-normal-priority Windows process.
    Configure `PUZZLE_SEEDS`, `PUZZLE_BATCH_SECONDS`, `PUZZLE_CANDIDATE_SECONDS`
    (maximum 120), `PUZZLE_DISTANCE_SECONDS` (maximum 120, 0 disables it) and
    `PUZZLE_MIN_STEPS` before starting Flask. The engine also curates as it
    writes: a puzzle must show enough of its mate (a mate in 2 or 3 in full, a
    mate in 4-5 in at least 3 steps, 6-10 in at least 5, 11+ in at least 7) and
    every mate in 6 or more needs two solver moves that are not forced answers to
    an immediate threat. Run `python puzzle_filter.py` to apply the same rules to
    a bank an older build produced; it reports the damage and writes nothing
    without `--apply`. Set longer batch and
    candidate budgets together when mining harder puzzles. Leaving puzzle mode kills
    the process immediately; a batch also has a five-second external timeout grace.
    Build/deploy from the C++ folder with `build.ps1 -Tests -DeployWeb`; see the
    sibling engine's [pipeline report](../connect4-c++/PUZZLES_V3.md) for guarantees
    and measured throughput. Restart Flask after updating Python code.
*   **File puzzles.** "Load from File" accepts `.txt` puzzle files in either the 2-line
    (`history` / `solution`) or the engine's 3-line (`board code` / `history` / `solution`)
    format.

---

## Piece textures

The light pieces are glazed clay (`clay_floor_001`), the dark ones oak veneer
(`oak_veneer_01`). `textures/` holds the 4k sources; `static/textures/` holds the 512px
copies the browser actually loads, built by `tools/build_textures.py` (Pillow). The
sources total ~40 MB, which is absurd for beads a few dozen pixels across — the shipped
set is ~250 KB.

Two things about the maps are worth knowing before changing them:

*   **The clay albedo is not a straight downscale.** A material's colour multiplies its
    albedo map, so a tint can only ever *darken* it, and clay_floor's albedo is a mid
    brown — no tint over it makes a white piece. `clay_floor_001_diff_pale.jpg` is
    therefore the source albedo's luminance remapped onto a narrow band just below white.
    The streaks and cracks survive as gentle shading; the relief still comes from the
    untouched normal and roughness maps. The oak albedo needs no such treatment, since
    darkening is exactly what its tint does.
*   **The two surfaces tile differently** (`CLAY_TEXTURE_REPEAT` / `OAK_TEXTURE_REPEAT` in
    `main.js`). Clay is mottling and reads at any scale, but the oak source is a whole
    plank: stretched once over a bead it puts about half a grain line on it, so it is
    tiled several times over before the wood looks like wood.

The oak map is an "ARM" pack — ambient occlusion, roughness and metalness in R, G and B,
which is the channel each of those three material slots reads, so one image fills them
all. Only AO and roughness are wired up; the veneer is not a metal.

If the textures fail to load the pieces fall back to flat colours, exactly as they looked
before they existed.

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
which the shared model and the puzzle generator's engine subprocess depend on. Startup prints the device, the
architecture detected in the checkpoint, and the puzzle-bank counts. Then open
<http://127.0.0.1:5000>.

`requirements.txt` is a full freeze of the shared environment, not a minimal dependency
list; the app itself only needs flask, torch and numpy.

---

## Project structure

```
/connect4-web-app/
├── bin/
│   └── connect4_3D.exe     # C++ engine, used here as the puzzle generator
├── models/
│   └── model_best.pth      # trained PyTorch checkpoint (gitignored)
├── puzzles/                # puzzle bank, mate_in_<k>.txt
├── static/
│   ├── engine/             # C++ engine as WebAssembly (connect4_engine.js + .wasm)
│   ├── css/style.css
│   ├── css/analysis.css
│   ├── js/
│   │   ├── analysis.js     # analysis panel
│   │   ├── columnLabels.js # 0- vs 1-based column numbering, display side only
│   │   ├── engine.js       # browser engine: analyze(), bestMove(), worker lifecycle
│   │   ├── engineWorker.js # Web Worker hosting the WebAssembly engine
│   │   ├── gameLogic.js    # client-side rules mirror
│   │   ├── main.js         # scene, input, game flow, puzzle mode, settings
│   │   └── sync.js         # room protocol, client half
│   ├── models/Piece.fbx    # piece mesh
│   └── textures/           # 512px piece maps, built from textures/
├── templates/index.html
├── tests/                  # engine.test.mjs (node --test), analysis_panel.html
├── textures/               # 4k texture sources (clay_floor_001, oak_veneer_01)
├── tools/
│   └── build_textures.py   # textures/ -> static/textures/ (needs Pillow)
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
*   AI strength is fixed: 500 MCTS simulations, and 3 seconds of minimax search on the
    viewer's own machine, so the minimax opponent is stronger on faster computers.
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
