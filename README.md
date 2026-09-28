# 3D Connect Four (web app)

Connect Four on a 4x4x4 grid in the browser, with a three.js board, two AI opponents,
live engine analysis, engine-generated puzzles and shared rooms. The opponents and the
analysis run **in the browser**; the Flask server only serves the page, the shared room
state and the puzzle bank.

![Gameplay Demo](./assets/gamePlay.gif)

## Features

* **Opponents.** A ResNet3D + MCTS agent (500 simulations, ONNX Runtime Web on WebGPU or
  WebAssembly) and the C++ minimax engine from
  [3d-connect-four-engine](https://github.com/Howard5241/3d-connect-four-engine) compiled
  to WebAssembly (3 s per move). Either can auto-reply from the settings panel.
* **Analysis.** Eval bar and ranked moves with continuations, searched by the engine in a
  Web Worker. Scores are engine units; `M<n>` is an exact mate in n winner moves, `≈M<n>`
  a proved but not yet shortest mate. Light shows even-depth evals, Dark odd-depth.
* **Puzzles.** Every solver move is the only win (or the only draw). Categories group
  by objective mate length: Quick 1–3, Medium 4–5, Long 6–11, Endgame 12+. `.txt`
  puzzle files can also be loaded.
* **Shared rooms.** Everyone on the page shares one board (`?room=<name>` for a
  separate one): moves, viewed position, planning ghosts, ghost lines and puzzles.
* **Board tools.** Hover preview, right-click planning ghosts, right-drag between two
  pieces to draw their four-in-a-row, arrow-key history, move-list paste, hex board
  code, occlusion outline and mask, and 1-based or 0-based column labels (display only).

## Running locally

Requires Python 3.11 and Flask (`pip install -r requirements.txt`).

```
python app.py
```

Open <http://127.0.0.1:5000>. Run `app.py` directly rather than `flask run`: it sets
`threaded=False`, which the puzzle generator's shared engine process relies on. Puzzle
generation needs `bin/connect4_3D.exe`, built from the engine repo.

Three.js and ONNX Runtime Web load from CDNs. The first AI move downloads about 60 MB
(the network plus ONNX Runtime), which the browser then caches.

## Layout

| Path | Role |
| :--- | :--- |
| `app.py` | Flask server: page, room API, puzzle API. COOP/COEP headers enable threaded WebAssembly. |
| `room_state.py`, `static/js/sync.js` | Shared room state (server) and polling client. |
| `puzzle_bank.py` | Puzzle bank (`puzzles/`) and background generation via the engine's `genpuzzle`. |
| `static/js/main.js` | Scene, input, game flow, puzzle mode, settings. |
| `static/js/engine.js`, `engineWorker.js`, `static/engine/` | WebAssembly engine for analysis and minimax. |
| `static/js/nnAgent.js`, `nnWorker.js`, `nnMcts.js`, `static/nn/model.onnx` | Neural opponent. |
| `static/js/analysis.js` | Analysis panel. |
| `static/models/piece.bin`, `static/textures/` | Bead mesh and 512px textures, built from `models/Piece.fbx` and `textures/`. |
| `ai_agent.py`, `game_logic.py`, `models/model_best.pth` | Training-side network, MCTS and rules. |
| `puzzle_stats.py`, `puzzle_filter.py` | Bank statistics and curation. |

## Rebuilding assets

| After changing | Run |
| :--- | :--- |
| The engine | `./build.ps1 -Wasm -DeployWeb` (or `./build_wasm.sh <this repo>`) in the engine repo |
| `models/model_best.pth` | `python tools/export_onnx.py` (torch, onnx) |
| `models/Piece.fbx` | `npm i --no-save three@0.160.0 meshoptimizer && node tools/build_piece.mjs` |
| `textures/` | `python tools/build_textures.py` (Pillow) |

Puzzle generation is tuned with `PUZZLE_SEEDS`, `PUZZLE_BATCH_SECONDS`,
`PUZZLE_CANDIDATE_SECONDS`, `PUZZLE_DISTANCE_SECONDS` and `PUZZLE_MIN_STEPS`; see the
engine's [puzzle docs](https://github.com/Howard5241/3d-connect-four-engine/blob/main/docs/PUZZLES.md).

## Tests

```
node --test tests/engine.test.mjs tests/nnAgent.test.mjs
python -m unittest test_puzzle_bank
```

`tests/analysis_panel.html` checks the analysis renderer when served from the repo root.

## Limitations

* Development server only: `debug=True`, a hard-coded secret key, no authentication, and
  room state is in memory.
* Anyone with the URL can move in a room; there is no turn ownership.
* Minimax strength depends on the viewer's machine (fixed 3 s budget).
