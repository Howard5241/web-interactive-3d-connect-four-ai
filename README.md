# 3D Connect Four (web app)

Connect Four on a 4x4x4 grid in the browser, with a three.js board, two AI opponents,
live engine analysis, puzzles and shared rooms. The opponents and the analysis run
**in the browser**. The site runs on Cloudflare: static files plus a small Worker whose
Durable Objects hold the rooms.

![Gameplay Demo](./assets/gamePlay.gif)

## Features

* **Rooms.** The menu creates public rooms (listed on the menu) or private ones (link
  only). Everyone in a room sees the same board, move list, planning ghosts, ghost lines,
  puzzles and log, synced over a WebSocket. The first two players to sit down play Light
  and Dark orange and everyone else watches. With one seat empty, the seated player plays
  both sides or lets the AI reply.
* **Opponents.** A ResNet3D + MCTS agent (500 simulations, ONNX Runtime Web on WebGPU or
  WebAssembly) and the C++ minimax engine from
  [3d-connect-four-engine](https://github.com/Howard5241/3d-connect-four-engine) compiled
  to WebAssembly (3 s per move).
* **Analysis.** Eval bar and ranked moves with continuations, searched by the engine in a
  Web Worker. `M<n>` is an exact mate in n winner moves, `≈M<n>` a proved but not yet
  shortest mate.
* **Puzzles.** Every solver move is the only win (or the only draw). Categories group
  by objective mate length: Quick 1–3, Medium 4–5, Long 6–11, Endgame 12+.
* **Board tools.** Hover preview, right-click planning ghosts, right-drag between two
  pieces to draw their four-in-a-row, arrow-key history, move-list paste, hex board
  code, occlusion outline and mask, and 1-based or 0-based column labels.

## Running locally

Requires Node 20+.

```
npm install
npm run dev:model   # once: copies the network into the local R2 bucket
npm run dev
```

Open <http://127.0.0.1:8787>. Three.js and ONNX Runtime Web load from CDNs.

## Deploying

The network (`public/static/nn/model.onnx`, about 34 MiB) is over Cloudflare's 25 MiB
limit for static files, so it is served from an R2 bucket instead.

```
npx wrangler login
npx wrangler r2 bucket create 3d-connect-four-models
npm run upload:model   # again whenever model.onnx changes
npm run deploy
```

## Layout

| Path | Role |
| :--- | :--- |
| `wrangler.jsonc` | Worker, static assets, Durable Objects and R2 bucket. |
| `worker/index.js` | Routes: room API, `/r/<code>` room pages, the network from R2. |
| `worker/room.js`, `worker/roomCore.js` | One Durable Object per room, and its rules (validation, seats, turns). |
| `worker/lobby.js` | The list of public rooms. |
| `public/index.html`, `static/js/menu.js` | Main menu. |
| `public/room.html`, `static/js/main.js` | Game page: scene, input, game flow, puzzle mode, settings. |
| `public/static/js/sync.js` | Room client. |
| `public/puzzles.json`, `static/js/puzzleBank.js` | Puzzle bank, built from `puzzles/` by `tools/build_puzzles.py`. |
| `public/static/js/engine.js`, `engineWorker.js`, `static/engine/` | WebAssembly engine for analysis and minimax. |
| `public/static/js/nnAgent.js`, `nnWorker.js`, `nnMcts.js`, `static/nn/model.onnx` | Neural opponent. |
| `public/static/models/piece.bin`, `static/textures/` | Bead mesh and 512px textures, built from `models/Piece.fbx` and `textures/`. |
| `puzzle_bank.py`, `puzzle_stats.py`, `puzzle_filter.py` | Bank loading, statistics and curation. |
| `ai_agent.py`, `game_logic.py`, `models/model_best.pth` | Training-side network, MCTS and rules. |

## Rebuilding assets

| After changing | Run |
| :--- | :--- |
| The engine | `./build_wasm.sh ../3d-connect-four-website/public` (or `./build.ps1 -Wasm -DeployWeb -WebApp ../3d-connect-four-website/public`) in the engine repo |
| `puzzles/` | `python tools/build_puzzles.py` |
| `models/model_best.pth` | `python tools/export_onnx.py` (torch, onnx), then `npm run upload:model` |
| `models/Piece.fbx` | `npm i --no-save three@0.160.0 meshoptimizer && node tools/build_piece.mjs` |
| `textures/` | `python tools/build_textures.py` (Pillow) |

## Tests

```
npm test
python -m unittest test_puzzle_bank
```

`tests/analysis_panel.html` checks the analysis renderer when served from the repo root.

## Limitations

* No accounts: a seat belongs to a browser tab until it leaves, and names are unverified.
* Minimax strength depends on the viewer's machine (fixed 3 s budget).
