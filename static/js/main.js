import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { ConnectFour3D } from './gameLogic.js';
import { RoomSync } from './sync.js';
import { AnalysisPanel } from './analysis.js';
import {
    columnRange, columnTag, formatColumn, formatColumns,
    onColumnNumberingChange, parseColumn, setColumnText, setOneIndexed,
} from './columnLabels.js';

let analysis = null;

// --- GLOBAL VARIABLES ---
let scene, camera, renderer, controls;
let game; // Game logic instance
let boardState; // Current state of the board
let clickTargets = []; // Invisible planes for detecting clicks
let pieces = []; // To hold the visible game pieces
let ghostPieces = []; // To hold the ghost pieces for planning
let previewPiece = null; // To hold the semi-transparent preview piece
let isRequestInProgress = false; // Prevents multiple clicks while waiting for the server
// Player colours run light-orange (a milky coffee) vs dark-orange (a roasted bean).
// Ghost and outline/mask variants are lightened so they stay legible against both the
// dark background and the piece they sit on.
let player1Color = 0xefb87c; // Light orange
let player2Color = 0x9c5a2a; // Dark orange
let player1GhostColor = 0xf7d9b4; // Light orange (ghost)
let player2GhostColor = 0xc0824c; // Dark orange (ghost)
let player1OutlineColor = 0xffe6c2; // Light orange (occlusion outline / mask)
let player2OutlineColor = 0xd99760; // Dark orange (occlusion outline / mask)
const PLAYER1_NAME = 'Light orange';
const PLAYER2_NAME = 'Dark orange';
let ghostPlayer1Material, ghostPlayer2Material;

// Occlusion overlays, one entry per piece on the board:
//   mask - a copy of the piece's own geometry, parented to the piece, drawn semi-
//          transparently wherever the piece is hidden behind another piece. Because it
//          reuses the piece geometry it covers exactly the blocked region, at any angle.
//   ring - the thin camera-facing outline at the piece's silhouette (null when the
//          outline-thickness setting is 0).
// Both are shown only while most of the piece is actually blocked (see updateOcclusionOverlays),
// and they fade in and out rather than popping.
let pieceOverlays = []; // [{ piece, mask, ring, key, fade }]

// How far each cell's overlay has faded in, keyed by cell index (z * 16 + y * 4 + x).
// updateBoard throws away and rebuilds every overlay object -- including on something as
// incidental as nudging a settings slider -- so the fade has to survive outside them, or
// every rebuild would restart the animation from nothing.
let occlusionFade = new Map();

// Bars drawn through each completed four-in-a-row, so the winning line is obvious.
let winHighlights = [];

// DOM Elements (will be assigned in init)
let STATUS_MSG, NEW_GAME_BTN, AI_MOVE_BTN, MINIMAX_MOVE_BTN, LOG_BOX, MOVE_HISTORY_BOX, MOVE_INPUT, COPY_HEX_BTN, COPY_MOVES_BTN, UNDO_BTN, PIECE_COUNT_VALUE;
let SETTINGS_BTN, SETTINGS_MODAL_OVERLAY, CLOSE_SETTINGS_BTN;
let PIECE_SIZE_SLIDER, PIECE_SIZE_VALUE, PIECE_OPACITY_SLIDER, PIECE_OPACITY_VALUE, AUTO_AI_TOGGLE, AUTO_MINIMAX_TOGGLE, DROP_ANIMATION_TOGGLE;
let OUTLINE_THICKNESS_SLIDER, OUTLINE_THICKNESS_VALUE, MASK_OPACITY_SLIDER, MASK_OPACITY_VALUE;
let COLUMN_NUMBERING_TOGGLE, COLUMN_NUMBERING_NOTE;

let gameSettings = {
    pieceSize: 1.0,
    pieceOpacity: 1.0,
    autoAIMove: false,
    autoMinimaxMove: false,
    dropAnimation: true,
    outlineThickness: 0.05,  // occlusion outline width, as a fraction of the piece radius (0 = off)
    maskOpacity: 0.38        // occlusion mask strength (0 = off)
};

// --- DROP ANIMATION ---
let activeDrops = [];            // in-flight piece drops: { mesh, startY, endY, start, duration }
const DROP_SPAWN_Y = 6.5;        // fixed height above the grid where a played piece spawns
const DROP_DURATION_MS = 450;    // time for a piece to fall to its cell

// --- BEST-MOVE INDICATOR (analysis mode) ---
// A bead marking the engine's current top move, breathing in and out so it reads as an
// annotation rather than as a piece someone has played. The panel only ever tells us the
// column; the cell it lands in is recomputed from the board every frame, so navigating
// history or playing a move re-aims the marker without the engine having to report again.
// The marker wears the colour of the side whose move it is: the lightened cream for Light,
// so it does not vanish into the dark background at its faintest, and Dark orange's own
// piece colour for Dark, so the two sides can never be mistaken for one another.
const BEST_MOVE_LIGHT_COLOR = 0xffe6c2;
const BEST_MOVE_DARK_COLOR = 0x9c5a2a;
const BEST_MOVE_CYCLE_MS = 3600;       // one full breath: slow enough to read as a glow, not a blink
const BEST_MOVE_SWAP_MS = 240;         // fade-out before the marker moves to another cell
const BEST_MOVE_MIN_OPACITY = 0.4;     // faintest point of the breath -- never fades away entirely
const BEST_MOVE_MAX_OPACITY = 0.65;    // stays plainly a hint, never as solid as a played piece
const BEST_MOVE_SCALE = 0.94;          // slightly inside a real piece, so a hover preview
                                       // over the same cell never z-fights with it
let bestMoveColumn = null;   // column the engine likes, or null when there is nothing to show
let bestMoveMesh = null;
let bestMoveCell = null;     // cell the mesh currently occupies, as [depth, row, col]
let bestMovePresence = 0;    // 0..1: how far the marker has faded in
let bestMoveLastFrame = 0;   // performance.now() at the previous update

// --- PIECE MODEL ---
// Pieces are drawn from an FBX model. The loaded geometry is normalised to a unit
// bounding sphere centred on the origin, so a mesh built from it and scaled by the
// piece-size setting occupies exactly the space the old SphereGeometry did.
// That keeps the drop animation, the stencil occlusion outlines and the piece-size
// setting working unchanged. Until the FBX loads (and if it fails) this stays a
// unit sphere, which reproduces the previous look exactly.
const PIECE_MODEL_URL = '/static/models/Piece.fbx';
let pieceBaseGeo = new THREE.SphereGeometry(1, 32, 32);
let pieceModelLoaded = false;
// The largest half-extent of the normalised geometry, i.e. how far the model actually
// reaches from its centre. The bounding SPHERE radius is 1 by construction, but the bead
// does not fill that sphere -- it only reaches ~0.85 -- so a circle of radius 1 would
// float outside its silhouette. This is the radius the outline ring and the occlusion
// coverage test use. 1.0 is exact for the fallback sphere.
let pieceSilhouetteRadius = 1.0;

let moveHistory = [];
let currentMoveIndex = 0;

// --- SHARED SESSION (see sync.js) ---
// The board is not private to this tab: it belongs to a room on the server that every
// viewer of the site reads from and writes to. Anything that changes what is on the
// board is pushed there; anything that arrives from there is applied here.
let sync = null;
let applyingRemote = false;   // true while a remote state is being applied: suppresses pushes
let engineLock = null;        // another viewer's in-progress AI/minimax search, or null
let viewers = [];             // everyone currently looking at this board

// --- PUZZLE MODE VARIABLES ---
let isPuzzleMode = false;
let puzzles = [];
let currentPuzzleIndex = 0;
let currentPuzzleSolutionIndex = 0;
let puzzleSource = null;          // 'file' | 'engine'
let selectedCategory = 'quick';  // chosen difficulty category for engine puzzles
// Category definitions (mirrors puzzle_bank.CATEGORIES); refreshed from the server.
let CATEGORIES = [
    { key: 'quick',   label: 'Quick puzzle',  range_label: '1–3 moves to find',  min: 1,  max: 3 },
    { key: 'medium',  label: 'Medium puzzle', range_label: '4–5 moves to find',  min: 4,  max: 5 },
    { key: 'long',    label: 'Long puzzle',   range_label: '6–11 moves to find', min: 6,  max: 11 },
    { key: 'endgame', label: 'Endgame',       range_label: '12+ moves to find',  min: 12, max: null },
];
const categoryLabel = (key) => (CATEGORIES.find(c => c.key === key) || {}).label || key;
let currentPuzzleSolved = false;
let generationPollTimer = null;  // interval id while a background generation runs
let generationRunning = false;   // is the engine currently auto-generating?
let lastCounts = {};             // most recent per-mate bank counts
let lastCategoryCounts = {};     // most recent per-category bank counts

// A 1x1 transparent PNG. The FBX references its source textures by absolute Windows
// path (C:\Users\...\clay_floor_001_*.jpg), which the browser obviously cannot fetch,
// so every texture request is redirected here. As exported, this file's texture
// connections are ones FBXLoader skips anyway ("undefined map is not supported"), so
// nothing is fetched today -- but a re-export with proper connections would otherwise
// start 404ing. We only ever want the geometry: the piece colour comes from the
// per-player material built in updateBoard.
const BLANK_TEXTURE_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function loadPieceModel(url) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((requested) => (requested === url ? url : BLANK_TEXTURE_URL));

    const root = await new FBXLoader(manager).loadAsync(url);
    root.updateMatrixWorld(true);

    let source = null;
    root.traverse((o) => { if (o.isMesh && !source) source = o; });
    if (!source) throw new Error('no mesh found in ' + url);

    const geo = source.geometry.clone();
    // Bake the node transform: this FBX carries a non-uniform "Lcl Scaling" of
    // (0.0045, 0.014, 0.0045), so the raw geometry is ~26000 units across and
    // anisotropically scaled. applyMatrix4 transforms the normals correctly too.
    geo.applyMatrix4(source.matrixWorld);
    if (!geo.attributes.normal) geo.computeVertexNormals();

    // Recentre (the model's pivot sits at its base, not its middle) and normalise to a
    // unit bounding sphere. Using the bounding SPHERE rather than the box guarantees no
    // vertex ever reaches past radius 1, so a piece can never grow larger than the
    // sphere it replaces and neighbouring cells (1.0 apart) still cannot intersect.
    geo.computeBoundingSphere();
    const { center, radius } = geo.boundingSphere;
    geo.translate(-center.x, -center.y, -center.z);
    geo.scale(1 / radius, 1 / radius, 1 / radius);
    geo.computeBoundingSphere();

    // How far the model really reaches from its centre. Recentring used the bounding
    // sphere's centre, so the box is not perfectly symmetric -- take the largest |extent|.
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    pieceSilhouetteRadius = Math.max(
        Math.abs(bb.min.x), Math.abs(bb.max.x),
        Math.abs(bb.min.y), Math.abs(bb.max.y),
        Math.abs(bb.min.z), Math.abs(bb.max.z));

    pieceBaseGeo.dispose();
    pieceBaseGeo = geo;
    pieceModelLoaded = true;
}

// Build a piece mesh at the current piece-size setting. `pieceBaseGeo` is shared by
// every piece, so all 64 pieces cost one geometry upload.
function createPieceMesh(material) {
    const mesh = new THREE.Mesh(pieceBaseGeo, material);
    mesh.scale.setScalar(0.4 * gameSettings.pieceSize);
    return mesh;
}

// --- INITIALIZATION ---

function init() {
    // Assign DOM elements
    STATUS_MSG = document.getElementById('status-message');
    NEW_GAME_BTN = document.getElementById('new-game-btn');
    AI_MOVE_BTN = document.getElementById('ai-move-btn');
    MINIMAX_MOVE_BTN = document.getElementById('minimax-move-btn');
    UNDO_BTN = document.getElementById('undo-btn');
    LOG_BOX = document.getElementById('log-box');
    MOVE_HISTORY_BOX = document.getElementById('move-history-box');
    PIECE_COUNT_VALUE = document.getElementById('piece-count-value');
    MOVE_INPUT = document.getElementById('move-input');
    COPY_HEX_BTN = document.getElementById('copy-hex-btn');
    COPY_MOVES_BTN = document.getElementById('copy-moves-btn');
    SETTINGS_BTN = document.getElementById('settings-btn');
    SETTINGS_MODAL_OVERLAY = document.getElementById('settings-modal-overlay');
    CLOSE_SETTINGS_BTN = document.getElementById('close-settings-btn');
    PIECE_SIZE_SLIDER = document.getElementById('piece-size-slider');
    PIECE_SIZE_VALUE = document.getElementById('piece-size-value');
    PIECE_OPACITY_SLIDER = document.getElementById('piece-opacity-slider');
    PIECE_OPACITY_VALUE = document.getElementById('piece-opacity-value');
    AUTO_AI_TOGGLE = document.getElementById('auto-ai-toggle');
    AUTO_MINIMAX_TOGGLE = document.getElementById('auto-minimax-toggle');
    DROP_ANIMATION_TOGGLE = document.getElementById('drop-animation-toggle');
    OUTLINE_THICKNESS_SLIDER = document.getElementById('outline-thickness-slider');
    OUTLINE_THICKNESS_VALUE = document.getElementById('outline-thickness-value');
    MASK_OPACITY_SLIDER = document.getElementById('mask-opacity-slider');
    MASK_OPACITY_VALUE = document.getElementById('mask-opacity-value');
    COLUMN_NUMBERING_TOGGLE = document.getElementById('column-numbering-toggle');
    COLUMN_NUMBERING_NOTE = document.getElementById('column-numbering-note');

    // Puzzle Mode Elements
    const PUZZLE_FILE_INPUT = document.getElementById('puzzle-file-input');
    const UPLOAD_PUZZLE_BTN = document.getElementById('upload-puzzle-btn');
    const PREV_PUZZLE_BTN = document.getElementById('prev-puzzle-btn');
    const NEXT_PUZZLE_BTN = document.getElementById('next-puzzle-btn');
    const RESET_PUZZLE_BTN = document.getElementById('reset-puzzle-btn');
    const EXIT_PUZZLE_BTN = document.getElementById('exit-puzzle-btn');
    const SHOW_SOLUTION_BTN = document.getElementById('show-solution-btn');

    // Engine puzzle setup elements
    const ENGINE_PUZZLE_BTN = document.getElementById('engine-puzzle-btn');
    const CANCEL_ENGINE_SETUP_BTN = document.getElementById('cancel-engine-setup-btn');
    const START_PUZZLE_BTN = document.getElementById('start-puzzle-btn');
    const GENERATE_PUZZLE_BTN = document.getElementById('generate-puzzle-btn');
    const CATEGORY_SELECTOR = document.getElementById('category-selector');

    // Puzzle Event Listeners
    UPLOAD_PUZZLE_BTN.addEventListener('click', () => PUZZLE_FILE_INPUT.click());
    PUZZLE_FILE_INPUT.addEventListener('change', handlePuzzleFileUpload);
    PREV_PUZZLE_BTN.addEventListener('click', handlePrevPuzzle);
    NEXT_PUZZLE_BTN.addEventListener('click', handleNextPuzzle);
    RESET_PUZZLE_BTN.addEventListener('click', () => loadPuzzle(currentPuzzleIndex));
    EXIT_PUZZLE_BTN.addEventListener('click', exitPuzzleMode);
    SHOW_SOLUTION_BTN.addEventListener('click', showSolution);

    // Engine puzzle setup listeners
    ENGINE_PUZZLE_BTN.addEventListener('click', openEnginePuzzleSetup);
    CANCEL_ENGINE_SETUP_BTN.addEventListener('click', closeEnginePuzzleSetup);
    START_PUZZLE_BTN.addEventListener('click', () => startEnginePuzzle(selectedCategory));
    GENERATE_PUZZLE_BTN.addEventListener('click', toggleGeneration);
    CATEGORY_SELECTOR.querySelectorAll('.cat-btn').forEach(btn => {
        btn.addEventListener('click', () => selectCategory(btn.dataset.category));
    });

    // Game Logic
    game = new ConnectFour3D();
    boardState = game.getInitialState();

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    // Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(4, 4, 6);

    // Renderer
    const container = document.getElementById('scene-container');
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(1.5, 1.5, 1.5); // Center of the 4x4x4 grid
    controls.enableDamping = true;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(5, 10, 7.5);
    scene.add(directionalLight);

    // Ghost Piece Materials
    ghostPlayer1Material = new THREE.MeshStandardMaterial({
        color: player1GhostColor,
        roughness: 0.5,
        opacity: 0.9,
        transparent: true
    });
    ghostPlayer2Material = new THREE.MeshStandardMaterial({
        color: player2GhostColor,
        roughness: 0.5,
        opacity: 0.9,
        transparent: true
    });

    // Draw Board Structure
    drawBoardGrid();
    drawColumnPoles();
    drawCornerLabels();
    createClickTargets();

    // Event Listeners
    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('mousedown', onColumnClick);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    // Right-click is used for planning ghosts (place on a column, clear on empty space),
    // so suppress the browser context menu over the board canvas.
    renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    NEW_GAME_BTN.addEventListener('click', startNewGame);
    AI_MOVE_BTN.addEventListener('click', requestAIMove); // Add listener for AI move button
    MINIMAX_MOVE_BTN.addEventListener('click', requestMinimaxMove);
    UNDO_BTN.addEventListener('click', undoLastMove);
    COPY_HEX_BTN.addEventListener('click', copyHexCode);
    COPY_MOVES_BTN.addEventListener('click', copyMoveHistory)
    
    
    
    // Settings Modal Listeners
    SETTINGS_BTN.addEventListener('click', () => {
        SETTINGS_MODAL_OVERLAY.classList.remove('hidden');
    });

    CLOSE_SETTINGS_BTN.addEventListener('click', () => {
        SETTINGS_MODAL_OVERLAY.classList.add('hidden');
    });

    SETTINGS_MODAL_OVERLAY.addEventListener('click', (event) => {
        if (event.target === SETTINGS_MODAL_OVERLAY) {
            SETTINGS_MODAL_OVERLAY.classList.add('hidden');
        }
    });

    // Settings Sliders
    PIECE_SIZE_SLIDER.addEventListener('input', (event) => {
        const newSize = parseFloat(event.target.value);
        gameSettings.pieceSize = newSize;
        PIECE_SIZE_VALUE.textContent = newSize.toFixed(1);
        updateBoard(boardState);
    });

    PIECE_OPACITY_SLIDER.addEventListener('input', (event) => {
        const newOpacity = parseFloat(event.target.value);
        gameSettings.pieceOpacity = newOpacity;
        PIECE_OPACITY_VALUE.textContent = newOpacity.toFixed(1);
        updateBoard(boardState);
    });

    OUTLINE_THICKNESS_SLIDER.addEventListener('input', (event) => {
        const newThickness = parseFloat(event.target.value);
        gameSettings.outlineThickness = newThickness;
        OUTLINE_THICKNESS_VALUE.textContent = newThickness.toFixed(2);
        updateBoard(boardState);
    });

    MASK_OPACITY_SLIDER.addEventListener('input', (event) => {
        const newOpacity = parseFloat(event.target.value);
        gameSettings.maskOpacity = newOpacity;
        MASK_OPACITY_VALUE.textContent = newOpacity.toFixed(2);
        updateBoard(boardState);
    });

    AUTO_AI_TOGGLE.addEventListener('change', (event) => {
        gameSettings.autoAIMove = event.target.checked;
        if (gameSettings.autoAIMove) {
            AUTO_MINIMAX_TOGGLE.checked = false;
            gameSettings.autoMinimaxMove = false;
        }
        logMessage(`Auto AI Move ${gameSettings.autoAIMove ? 'enabled' : 'disabled'}.`);
    });

    AUTO_MINIMAX_TOGGLE.addEventListener('change', (event) => {
        gameSettings.autoMinimaxMove = event.target.checked;
        if (gameSettings.autoMinimaxMove) {
            AUTO_AI_TOGGLE.checked = false;
            gameSettings.autoAIMove = false;
        }
        logMessage(`Auto Minimax Move ${gameSettings.autoMinimaxMove ? 'enabled' : 'disabled'}.`);
    });

    DROP_ANIMATION_TOGGLE.addEventListener('change', (event) => {
        gameSettings.dropAnimation = event.target.checked;
        logMessage(`Piece drop animation ${gameSettings.dropAnimation ? 'enabled' : 'disabled'}.`);
    });

    // Purely a relabelling: the board, the history and everything sent to the server stay
    // 0-based, so nothing here touches the position.
    COLUMN_NUMBERING_TOGGLE.addEventListener('change', (event) => {
        setOneIndexed(event.target.checked);
    });

    // Text that is written once and left alone has to be redrawn by hand. The log and the
    // status line re-render themselves from their column tags; the analysis panel redraws
    // its own lines; these are the rest.
    onColumnNumberingChange(() => {
        redrawCornerLabels();
        updateMoveHistory(moveHistory);
        refreshColumnNumberingHints();
        logMessage(`Columns are now numbered ${columnRange()}.`);
    });
    refreshColumnNumberingHints();

    window.addEventListener('keydown', handleKeyDown);
    MOVE_INPUT.addEventListener('keydown', handleMoveInputChange);

    analysis = new AnalysisPanel(onWindowResize, column => handlePlayerMove(column), setBestMove,
        line => handlePlayEngineLine(line));
    for (const [id, delta] of [
        ['analysis-first', () => -currentMoveIndex],
        ['analysis-back', () => -1],
        ['analysis-next', () => 1],
        ['analysis-last', () => moveHistory.length - currentMoveIndex],
    ]) {
        document.getElementById(id).addEventListener('click', () => {
            if (!isRequestInProgress && !isPuzzleMode) navigateHistory(delta());
        });
    }
    document.getElementById('analysis-toggle').addEventListener('click', () => {
        if (isPuzzleMode) {
            logMessage('Exit Puzzle Mode before starting analysis.');
            return;
        }
        analysis.setPosition(moveHistory.slice(0, currentMoveIndex));
        analysis.setEnabled(!analysis.enabled);
    });

    if (!pieceModelLoaded) {
        logMessage('Piece model unavailable — using default spheres.');
    }

    // Join the shared board. Everything above is per-viewer (camera, settings, the
    // scene itself); from here on the position is the room's, not this tab's.
    initSync();

    // Start Animation Loop
    animate();
}

// The move box's placeholder and the note under the settings toggle both quote the
// numbering, so both are rewritten whenever it changes.
function refreshColumnNumberingHints() {
    const example = formatColumns([1, 3, 12, 15]);
    MOVE_INPUT.placeholder = `e.g., ${example} or ${example.replace(/ /g, ',')}`;
    COLUMN_NUMBERING_NOTE.textContent = 'Display only — the board labels, move history, log '
        + `and analysis panel number the columns ${columnRange()}.`;
}

// Copied in the numbering on screen, and read back the same way by the move box, so a
// copied position pastes back into the same position it came from.
async function copyMoveHistory() {
    const moves = moveHistory.slice(0, currentMoveIndex);
    const movesString = formatColumns(moves);
    try {
        await navigator.clipboard.writeText(movesString);
        logMessage(`Copied moves to clipboard: ${moves.map(columnTag).join(' ')}`);
        // Optional: Visual feedback
        const originalText = COPY_MOVES_BTN.textContent;
        COPY_MOVES_BTN.textContent = '✅';
        setTimeout(() => {
            COPY_MOVES_BTN.textContent = '📝';
        }, 1500);
    } catch (err) {
        console.error('Failed to copy moves: ', err);
        logMessage('Error: Could not copy moves.');
    }
}

async function copyHexCode() {
    const hexCode = game.getStateHexCode(boardState);
    try {
        await navigator.clipboard.writeText(hexCode);
        logMessage(`Copied hex to clipboard: ${hexCode}`);
        // Optional: Visual feedback
        const originalText = COPY_HEX_BTN.textContent;
        COPY_HEX_BTN.textContent = '✅';
        setTimeout(() => {
            COPY_HEX_BTN.textContent = '📋';
        }, 1500);
    } catch (err) {
        console.error('Failed to copy hex code: ', err);
        logMessage('Error: Could not copy hex code.');
    }
}

// --- 3D BOARD DRAWING --- 

// The board is modelled on the real-world game: a flat 4x4 base plate with a vertical
// pole rising out of the centre of each square. Pieces are beads that thread onto a
// pole and slide down, so the board needs no wireframe box to imply the third
// dimension -- the poles themselves show where each column is and how tall it is.
const BASE_PLANE_Y = -0.5;   // the base plate, half a cell below the bottom layer of pieces
const POLE_TOP_Y = 3.3;      // just clear of the top bead, whose crown reaches y = 3.31
const POLE_RADIUS = 0.04;    // the beads' narrowest bore is 0.142 at default piece size

// Just the 4x4 grid of the base plate, in the horizontal plane.
function drawBoardGrid() {
    // depthWrite:false keeps the grid out of the depth buffer, so the occlusion
    // outlines (which draw where a piece is behind existing depth) are triggered
    // only by other pieces and never by these thin lines. depthTest stays on, so
    // pieces still correctly draw over the lines.
    const material = new THREE.LineBasicMaterial({ color: 0x555555, depthWrite: false });
    const points = [];
    const size = 4;
    const offset = -0.5;

    for (let i = 0; i <= size; i++) {
        // Lines running along X, one per grid row...
        points.push(new THREE.Vector3(offset, BASE_PLANE_Y, offset + i));
        points.push(new THREE.Vector3(offset + size, BASE_PLANE_Y, offset + i));
        // ...and along Z, one per grid column.
        points.push(new THREE.Vector3(offset + i, BASE_PLANE_Y, offset));
        points.push(new THREE.Vector3(offset + i, BASE_PLANE_Y, offset + size));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.LineSegments(geometry, material);
    scene.add(line);
}

// One upright pole per column, rising from the centre of its square on the base plate.
// Cell (col, row) centres on x = col, z = row -- the same mapping used by the pieces and
// by createClickTargets.
function drawColumnPoles() {
    const height = POLE_TOP_Y - BASE_PLANE_Y;
    // Shared by all 16 poles.
    const geometry = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, height, 16);
    // The poles must be drawn AFTER the occlusion outlines. They are solid and write
    // depth, so drawing them first makes any pole standing in front of a piece satisfy
    // that piece's outline GreaterDepth test, lighting up a ring around a piece nothing
    // is really hiding. Ordering after the outlines keeps them a piece-vs-piece signal.
    //
    // renderOrder alone cannot do this: three.js draws the whole opaque list before the
    // whole transparent list and only sorts by renderOrder *within* a list, and the
    // outline rings are transparent. So the poles opt into the transparent list at full
    // opacity -- visually identical, but now renderOrder 1000 really does put them last.
    const material = new THREE.MeshStandardMaterial({
        color: 0x8a8a8a,
        roughness: 0.6,
        metalness: 0.1,
        transparent: true,
        opacity: 1.0
    });

    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            const pole = new THREE.Mesh(geometry, material);
            pole.position.set(col, BASE_PLANE_Y + height / 2, row);
            pole.renderOrder = 1000;
            scene.add(pole);
        }
    }
}

// Build a camera-facing text label (a Sprite always faces the camera).
function makeTextSprite(text) {
    const canvas = document.createElement('canvas');
    const S = 256;
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 150px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeText(text, S / 2, S / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, S / 2, S / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    // depthWrite:false so these overlay labels never populate the depth buffer and
    // therefore never trigger a piece's occlusion outline.
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.9, 0.9, 0.9);
    // depthTest:false already means "always on top", but that only holds against
    // geometry drawn earlier. The column poles render at 1000, so the labels have to
    // sit above them to stay readable rather than be painted over.
    sprite.renderOrder = 2000;
    return sprite;
}

// Label the four bottom-layer corner columns (0, 3, 12, 15). Each number sits
// diagonally outside its corner cell so it reads as belonging to that column.
// A column index maps to grid coords: x = col % 4, z = floor(col / 4).
// The numbers themselves follow the column-numbering setting; the columns they mark
// do not.
let cornerLabels = [];   // the four sprites, kept so a relabelling can replace them

function drawCornerLabels() {
    const out = 1.2; // how far outside the grid (grid spans -0.5..3.5) to place labels
    const labels = [
        { n: 0,  x: -out,     z: -out },     // corner cell (x=0, z=0): to the left & front
        { n: 3,  x: 3 + out,  z: -out },     // corner cell (x=3, z=0)
        { n: 12, x: -out,     z: 3 + out },  // corner cell (x=0, z=3)
        { n: 15, x: 3 + out,  z: 3 + out },  // corner cell (x=3, z=3)
    ];
    for (const l of labels) {
        const sprite = makeTextSprite(formatColumn(l.n));
        sprite.position.set(l.x, 0, l.z); // y = 0 is the bottom layer
        scene.add(sprite);
        cornerLabels.push(sprite);
    }
}

// Each label bakes its number into a canvas texture, so changing the numbering means
// building the sprites again rather than editing them.
function redrawCornerLabels() {
    for (const sprite of cornerLabels) {
        scene.remove(sprite);
        sprite.material.map.dispose();
        sprite.material.dispose();
    }
    cornerLabels = [];
    drawCornerLabels();
}

function clearGhostPieces() {
    ghostPieces.forEach(p => scene.remove(p));
    ghostPieces = [];
}

function createClickTargets() {
    const planeGeo = new THREE.PlaneGeometry(1, 1);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });

    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            const plane = new THREE.Mesh(planeGeo, planeMat);
            plane.position.set(col, 4, row); // Positioned above the board
            plane.rotation.x = -Math.PI / 2;
            plane.userData.column = row * 4 + col; // Store the action index
            scene.add(plane);
            clickTargets.push(plane);
        }
    }
}

// dropCoords, when provided as [depth, row, col], is the cell of a just-played
// piece; if the drop animation is enabled that piece spawns above the grid and
// falls into place instead of appearing instantly.
function updateBoard(boardState, dropCoords = null) {
    analysis?.setPosition(moveHistory.slice(0, currentMoveIndex));
    // Any in-flight drops reference pieces we are about to remove -- drop them.
    activeDrops = [];

    // Clear existing pieces
    pieces.forEach(p => scene.remove(p));
    pieces = [];

    // Clear occlusion overlays (rebuilt alongside the pieces below). The masks are
    // children of their piece and were removed with it above; only the rings are
    // scene-level, since they have to be re-oriented to face the camera each frame.
    pieceOverlays.forEach(o => { if (o.ring) scene.remove(o.ring); });
    pieceOverlays = [];

    // Rebuild the fade table from scratch, seeding each new overlay from the outgoing one
    // for the same cell. Anything not carried over (a cell emptied by an undo) is dropped.
    const previousFade = occlusionFade;
    occlusionFade = new Map();

    clearGhostPieces();

    // Also remove the preview piece when the board updates
    if (previewPiece) {
        scene.remove(previewPiece);
        previewPiece = null;
    }

    const pieceScale = 0.4 * gameSettings.pieceSize;
    // Where the piece's image actually ends on screen. Not the same as pieceScale: the
    // model only reaches `pieceSilhouetteRadius` (~0.85) of its bounding sphere, so a
    // ring drawn at pieceScale would hang visibly outside the bead.
    const silhouetteRadius = pieceSilhouetteRadius * pieceScale;

    const isTransparent = gameSettings.pieceOpacity < 1.0;

    // Outline ring geometry: its OUTER edge sits at the silhouette and it extends
    // INWARD by the chosen thickness, so the outline never spills past the piece's own
    // image. Self-occlusion is prevented by per-piece stencil ids (below), not by the
    // ring's placement, so it can safely reach the edge. Skipped when thickness is 0.
    const outlineThickness = gameSettings.outlineThickness;
    const showOutlines = outlineThickness > 0;
    const outlineGeo = showOutlines
        ? new THREE.RingGeometry(Math.max(0, silhouetteRadius * (1 - outlineThickness)), silhouetteRadius, 48)
        : null;
    const showMasks = gameSettings.maskOpacity > 0;

    // Each piece stamps a unique id (1..64) into the stencil buffer wherever it is the
    // front-most surface. A piece's outline then draws only where the front-most piece
    // is a DIFFERENT piece, so a piece can never trigger its own outline.
    let stencilId = 0;

    for (let z = 0; z < 4; z++) { // Depth
        for (let y = 0; y < 4; y++) { // Row
            for (let x = 0; x < 4; x++) { // Col
                const pieceValue = boardState[z][y][x];
                if (pieceValue !== 0) {
                    stencilId++;

                    const material = new THREE.MeshStandardMaterial({
                        color: (pieceValue === 1) ? player1Color : player2Color,
                        roughness: 0.5,
                        opacity: gameSettings.pieceOpacity,
                        transparent: isTransparent,
                        stencilWrite: true,
                        stencilRef: stencilId,
                        stencilFunc: THREE.AlwaysStencilFunc,
                        stencilZPass: THREE.ReplaceStencilOp
                    });
                    const piece = createPieceMesh(material);
                    const targetY = 3 - z;
                    piece.position.set(x, targetY, y);
                    scene.add(piece);
                    pieces.push(piece);

                    // Animate this piece falling in if it's the one just played.
                    if (dropCoords && gameSettings.dropAnimation &&
                        dropCoords[0] === z && dropCoords[1] === y && dropCoords[2] === x) {
                        piece.position.y = DROP_SPAWN_Y;
                        activeDrops.push({
                            mesh: piece,
                            startY: DROP_SPAWN_Y,
                            endY: targetY,
                            start: performance.now(),
                            duration: DROP_DURATION_MS
                        });
                    }

                    const overlayColor = (pieceValue === 1) ? player1OutlineColor : player2OutlineColor;

                    // Occlusion outline: a thin camera-facing rim at the piece's silhouette,
                    // repositioned each frame (see updateOcclusionOverlays). Drawn BEFORE the
                    // mask, because the mask rewrites the stencil buffer as it goes (below)
                    // and would otherwise suppress this ring. Both are the same colour, so
                    // the mask blending over the ring leaves it looking unchanged.
                    let outlineRing = null;
                    if (showOutlines) {
                        const outlineMat = new THREE.MeshBasicMaterial({
                            color: overlayColor,
                            side: THREE.DoubleSide,
                            transparent: true,
                            opacity: 0,          // driven by the fade in updateOcclusionOverlays
                            depthTest: true,
                            depthFunc: THREE.GreaterDepth,
                            depthWrite: false,
                            stencilWrite: true,
                            stencilRef: stencilId,
                            stencilFunc: THREE.NotEqualStencilFunc,
                            stencilFail: THREE.KeepStencilOp,
                            stencilZFail: THREE.KeepStencilOp,
                            stencilZPass: THREE.KeepStencilOp
                        });
                        outlineRing = new THREE.Mesh(outlineGeo, outlineMat);
                        outlineRing.position.copy(piece.position);
                        outlineRing.renderOrder = 997;
                        outlineRing.visible = false;
                        scene.add(outlineRing);
                    }

                    // Occlusion mask: a second copy of the piece's own geometry, parented
                    // to the piece so it shares its transform exactly (including while the
                    // piece is falling). Drawn with GreaterDepth it appears only on the
                    // fragments where the piece lost the depth test, i.e. precisely the
                    // region another piece is hiding -- the whole blocked area, in the
                    // model's true silhouette, from every camera angle.
                    //
                    // Being geometrically identical to the piece, its depth values are
                    // exactly equal wherever the piece is visible, and GreaterDepth is a
                    // strict test, so it can never bleed over the unobstructed part.
                    let mask = null;
                    if (showMasks) {
                        const maskMat = new THREE.MeshBasicMaterial({
                            color: overlayColor,
                            transparent: true,
                            opacity: 0,          // ramps up to gameSettings.maskOpacity as it fades in
                            depthTest: true,
                            depthFunc: THREE.GreaterDepth,   // draw only where behind other geometry
                            depthWrite: false,
                            // ...and only where the front-most piece is a different piece, so a
                            // piece's own near side never masks its own far side.
                            stencilWrite: true,
                            stencilRef: stencilId,
                            stencilFunc: THREE.NotEqualStencilFunc,
                            stencilFail: THREE.KeepStencilOp,
                            stencilZFail: THREE.KeepStencilOp,
                            // The bead is a torus with a bore, so a single camera ray can cross
                            // TWO front-facing surfaces of it -- the outer shell and the far wall
                            // of the hole. Both pass GreaterDepth, so the alpha blend happened
                            // twice over the middle of the piece and that band came out lighter
                            // than the rest. Stamping this piece's own id on every fragment that
                            // gets drawn makes the second crossing fail its own NotEqual test, so
                            // each pixel is blended exactly once.
                            //
                            // This is safe for the other pieces' masks: the only id a mask can
                            // write is its own, and a pixel carrying piece P's id is by definition
                            // a pixel where P is hidden -- so wherever the stamp differs from what
                            // the piece pass left behind, P was not the front-most surface there,
                            // and any mask that now passes the stencil test still has to clear
                            // GreaterDepth against the true occluder's depth.
                            stencilZPass: THREE.ReplaceStencilOp
                        });
                        mask = new THREE.Mesh(pieceBaseGeo, maskMat);
                        mask.renderOrder = 998;
                        mask.visible = false;   // switched on by updateOcclusionOverlays
                        piece.add(mask);
                    }

                    if (mask || outlineRing) {
                        const key = z * 16 + y * 4 + x;
                        const overlay = { piece, mask, ring: outlineRing, key, fade: previousFade.get(key) || 0 };
                        occlusionFade.set(key, overlay.fade);
                        // Seed the meshes from the carried-over fade, so a rebuild that lands
                        // mid-fade does not blank the overlay for a frame.
                        applyOverlayFade(overlay);
                        pieceOverlays.push(overlay);
                    }
                }
            }
        }
    }

    updateWinHighlight(boardState, silhouetteRadius);
}

// --- WIN HIGHLIGHT ---

const WIN_LINE_COLOR = 0x4fd1ff;   // cyan: neither player's colour, so it reads as an annotation
const WIN_LINE_RADIUS = 0.075;     // half-thickness of the bar
const WIN_LINE_OPACITY = 0.9;

const _winAxis = new THREE.Vector3();
const _winUp = new THREE.Vector3(0, 1, 0);

function clearWinHighlight() {
    winHighlights.forEach(m => {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
    });
    winHighlights = [];
}

// Draw a thick bar through every four-in-a-row on the board. A move can complete more
// than one line at once, so all of them get a bar.
//
// `reach` is how far past the two end pieces' centres the bar should extend -- the piece
// silhouette radius, so the bar spans the full run rather than stopping at the middle of
// the outermost beads.
function updateWinHighlight(state, reach) {
    clearWinHighlight();
    if (!game) return;

    const lines = game.getWinningLines(state);
    if (lines.length === 0) return;

    for (const { cells } of lines) {
        // Board [z, y, x] maps to world (x, 3 - z, y), the same mapping the pieces use.
        const from = cellToWorld(cells[0]);
        const to = cellToWorld(cells[cells.length - 1]);

        _winAxis.copy(to).sub(from);
        const span = _winAxis.length();
        _winAxis.normalize();

        // A capsule is a cylinder with hemispherical caps, so the bar ends in a dome over
        // the outermost bead instead of a flat disc. Its total length is body + 2 * radius,
        // hence the radius subtracted here.
        const body = Math.max(0.001, span + 2 * reach - 2 * WIN_LINE_RADIUS);
        const geometry = new THREE.CapsuleGeometry(WIN_LINE_RADIUS, body, 6, 16);
        const material = new THREE.MeshBasicMaterial({
            color: WIN_LINE_COLOR,
            transparent: true,
            opacity: WIN_LINE_OPACITY,
            // The bar runs through the centres of the beads, so with a normal depth test it
            // would be buried inside them and only visible in the gaps. Drawing it on top
            // instead makes it read as a highlight laid over the winning run.
            depthTest: false,
            depthWrite: false
        });

        const bar = new THREE.Mesh(geometry, material);
        bar.position.copy(from).add(to).multiplyScalar(0.5);
        // CapsuleGeometry is built along +Y; rotate that axis onto the line's direction.
        bar.quaternion.setFromUnitVectors(_winUp, _winAxis);
        // Above the poles (1000) but below the corner labels (2000).
        bar.renderOrder = 1500;
        // Hold it back until the winning piece has finished dropping (see updateDrops).
        bar.visible = activeDrops.length === 0;
        scene.add(bar);
        winHighlights.push(bar);
    }
}

function cellToWorld([z, y, x]) {
    return new THREE.Vector3(x, 3 - z, y);
}

function updateMoveHistory(newMoveHistory) {
    moveHistory = newMoveHistory;
    MOVE_HISTORY_BOX.innerHTML = ''; // Clear existing move history
    moveHistory.forEach((move, index) => {
        const moveBox = document.createElement('div');
        moveBox.classList.add('move-box');
        moveBox.classList.add(index % 2 === 0 ? 'move-player1' : 'move-player2');
        
        // Highlight the currently viewed move
        if (index === currentMoveIndex - 1) {
            moveBox.classList.add('current-move');
        }

        moveBox.textContent = formatColumn(move);
        MOVE_HISTORY_BOX.appendChild(moveBox);
    });
    MOVE_HISTORY_BOX.scrollTop = MOVE_HISTORY_BOX.scrollHeight;
    updatePieceCount();
}

// Shows how many pieces are currently on the board (which is the number of
// moves being displayed, not necessarily the full history when scrubbing).
function updatePieceCount() {
    if (PIECE_COUNT_VALUE) {
        PIECE_COUNT_VALUE.textContent = currentMoveIndex;
    }
}


// --- SHARED SESSION ---

function initSync() {
    sync = new RoomSync({
        onState: applyRemoteState,
        onPresence: renderPresence,
        onLog: renderRemoteLog,
        onConnection: renderConnection,
    });
    sync.start();
}

/** Everything about the local view that other viewers should see too. */
function fullSharedState() {
    return {
        mode: isPuzzleMode ? 'puzzle' : 'game',
        moves: moveHistory,
        view_index: currentMoveIndex,
        ghosts: ghostCells(),
        puzzle: isPuzzleMode ? sharedPuzzleState() : null,
        progress: isPuzzleMode ? sharedProgress() : null,
    };
}

// The puzzle set: where it came from and the puzzles themselves. Changes only when a
// new puzzle is fetched or a file is loaded, which is why the progress through it is
// tracked separately -- an uploaded file can hold hundreds of puzzles.
function sharedPuzzleState() {
    return { source: puzzleSource, puzzles, category: selectedCategory };
}

function sharedProgress() {
    return {
        index: currentPuzzleIndex,
        solution_index: currentPuzzleSolutionIndex,
        solved: currentPuzzleSolved,
    };
}

/**
 * Publish a change so the other viewers see it.
 * `expect` makes the push conditional on nobody having changed the board since we last
 * heard from the server -- use it for anything that adds a move, so two people clicking
 * at once cannot both play.
 */
async function pushShared(patch, { expect = false, log = null } = {}) {
    if (!sync || applyingRemote) return { ok: true };   // remote changes are not echoed back
    const result = await sync.push(patch, { expect, log });
    if (result.conflict) {
        // sync has already applied the state we missed; our optimistic move is gone.
        logMessage('Another viewer moved first — the board has been resynced.');
    }
    return result;
}

/** The board as the rest of the room should see it after a local move. */
function pushBoard({ log = null, expect = true } = {}) {
    return pushShared({
        mode: isPuzzleMode ? 'puzzle' : 'game',
        moves: moveHistory,
        view_index: currentMoveIndex,
        ghosts: ghostCells(),
        progress: isPuzzleMode ? sharedProgress() : null,
    }, { expect, log });
}

/** Claim/release the engine so two viewers cannot start a search at the same time. */
function setEngineBusy(what) {
    return pushShared({ busy: what ? { what } : null });
}

function engineBusyElsewhere() {
    return engineLock !== null;
}

// Apply a board sent by another viewer. Everything here mirrors what the local move
// paths do, minus the pushes -- `applyingRemote` keeps this from bouncing back out.
function applyRemoteState(state) {
    if (!state || !game) return;
    applyingRemote = true;
    try {
        updateEngineLock(state.busy);

        const moves = Array.isArray(state.moves) ? state.moves : [];
        const viewIndex = Math.max(0, Math.min(state.view_index ?? moves.length, moves.length));

        // Polling delivers whole snapshots, and most of them describe the board already
        // on screen -- our own move coming back, or somebody claiming the engine. Redrawing
        // for those would restart drop animations and flicker, so compare first.
        if (boardMatchesLocal(state, moves, viewIndex)) {
            refreshControls();
            return;
        }

        if (state.mode === 'puzzle' && state.puzzle) {
            const p = state.puzzle;
            const progress = state.progress || {};
            if (!isPuzzleMode) enterPuzzleMode();   // resets currentPuzzleIndex, so go first
            puzzles = Array.isArray(p.puzzles) ? p.puzzles : [];
            puzzleSource = p.source || null;
            if (p.category) selectedCategory = p.category;
            currentPuzzleIndex = progress.index || 0;
            currentPuzzleSolutionIndex = progress.solution_index || 0;
            currentPuzzleSolved = !!progress.solved;
            updatePuzzleInfo();
        } else if (isPuzzleMode) {
            leavePuzzleUI();
        }

        const dropCoords = remoteDropCoords(moves, viewIndex);

        moveHistory = moves;
        currentMoveIndex = viewIndex;
        boardState = game.getStateFromMoves(moves.slice(0, viewIndex)).state;

        updateBoard(boardState, dropCoords);       // clears ghosts...
        renderGhosts(state.ghosts || []);          // ...so redraw the shared ones
        updateMoveHistory(moveHistory);
        refreshControls();
    } finally {
        applyingRemote = false;
    }
}

// Does this shared state describe exactly what this tab is already showing?
function boardMatchesLocal(state, moves, viewIndex) {
    if ((state.mode === 'puzzle') !== isPuzzleMode) return false;
    if (viewIndex !== currentMoveIndex) return false;
    if (moves.length !== moveHistory.length) return false;
    if (!moves.every((m, i) => m === moveHistory[i])) return false;

    const mine = ghostCells();
    const theirs = state.ghosts || [];
    if (theirs.length !== mine.length) return false;
    if (!theirs.every((g, i) => g.x === mine[i].x && g.y === mine[i].y
                             && g.z === mine[i].z && g.player === mine[i].player)) return false;

    if (isPuzzleMode) {
        const p = state.progress || {};
        if ((p.index || 0) !== currentPuzzleIndex) return false;
        if ((p.solution_index || 0) !== currentPuzzleSolutionIndex) return false;
        if (!!p.solved !== currentPuzzleSolved) return false;
        // Two different puzzles can share a history, so compare the line to solve too.
        const here = puzzles[currentPuzzleIndex];
        const there = (state.puzzle && state.puzzle.puzzles || [])[currentPuzzleIndex];
        if (JSON.stringify(here && here.solution) !== JSON.stringify(there && there.solution)) {
            return false;
        }
    }
    return true;
}

// Track who, if anyone, is holding the server's engine, and say so once.
function updateEngineLock(busy) {
    const lock = (busy && busy.client !== sync.clientId) ? busy : null;
    const wasHeldBy = engineLock && engineLock.client;
    engineLock = lock;
    if (lock && lock.client !== wasHeldBy) {
        const who = viewers.find(v => v.id === lock.client);
        const engine = lock.what === 'minimax' ? 'the minimax engine' : 'the AI';
        logMessage(`${who ? who.name : 'Another viewer'} is running ${engine}…`);
    }
}

// If the incoming moves are ours plus exactly one more, that one move was just played
// by someone else and deserves the drop animation rather than appearing out of nowhere.
function remoteDropCoords(moves, viewIndex) {
    if (viewIndex !== moves.length) return null;
    if (moves.length !== moveHistory.length + 1) return null;
    if (currentMoveIndex !== moveHistory.length) return null;
    if (!moveHistory.every((m, i) => m === moves[i])) return null;

    const before = game.getStateFromMoves(moves.slice(0, -1)).state;
    return game.getLandingPosition(before, moves[moves.length - 1]);
}

// Ghost (planning) pieces travel as world coordinates, which is exactly what a mesh
// needs and survives a board rebuild losing the meshes themselves.
function ghostCells() {
    return ghostPieces.map(p => ({
        x: p.position.x,
        y: p.position.y,
        z: p.position.z,
        player: p.material === ghostPlayer1Material ? 1 : -1,
    }));
}

function renderGhosts(cells) {
    clearGhostPieces();
    cells.forEach(c => {
        const piece = createPieceMesh(c.player === 1 ? ghostPlayer1Material : ghostPlayer2Material);
        piece.position.set(c.x, c.y, c.z);
        piece.userData.isGhost = true;
        scene.add(piece);
        ghostPieces.push(piece);
    });
}

// Put the buttons in the right state for the board as it now stands. checkGameOver does
// this for locally-driven moves; a board that arrived from another viewer needs the same
// treatment without re-announcing the result in the log.
function refreshControls() {
    const [, isTerminal] = game.getValueAndTerminated(boardState);
    if (isTerminal || isPuzzleMode) {
        setButtonsDisabled(true);
        NEW_GAME_BTN.disabled = isRequestInProgress;
        UNDO_BTN.disabled = true;
    } else {
        setButtonsDisabled(isRequestInProgress || currentMoveIndex !== moveHistory.length);
        NEW_GAME_BTN.disabled = isRequestInProgress;
    }
}

// --- PRESENCE & SHARED LOG ---

function renderPresence(clients) {
    viewers = clients;
    const list = document.getElementById('viewer-list');
    if (!list) return;
    list.innerHTML = '';
    clients.forEach(c => {
        const chip = document.createElement('span');
        chip.className = 'viewer-chip';
        chip.style.borderColor = c.color;
        const dot = document.createElement('span');
        dot.className = 'viewer-dot';
        dot.style.backgroundColor = c.color;
        chip.appendChild(dot);
        chip.appendChild(document.createTextNode(
            c.id === sync.clientId ? `${c.name} (you)` : c.name));
        list.appendChild(chip);
    });
    renderConnection(sync.online ? 'online' : 'offline');
}

function renderConnection(status) {
    const label = document.getElementById('presence-summary');
    if (!label) return;
    if (status === 'offline') {
        label.textContent = '⚠ Disconnected — reconnecting…';
        label.classList.add('offline');
        return;
    }
    label.classList.remove('offline');
    const n = viewers.length || 1;
    const room = sync && sync.room !== 'main' ? ` · room “${sync.room}”` : '';
    label.textContent = n === 1
        ? `Shared board · 1 viewer${room}`
        : `Shared board · ${n} viewers${room}`;
}

function renderRemoteLog(entries) {
    entries.forEach(e => {
        setColumnText(STATUS_MSG, `${e.name}: ${e.text}`);
        const line = document.createElement('p');
        line.className = 'log-remote';
        const who = document.createElement('span');
        who.className = 'log-author';
        who.style.color = e.color;
        who.textContent = `${e.name}: `;
        // The writer may be on the other numbering, so the columns arrive as tags and
        // are rendered here, in this viewer's terms.
        const said = document.createElement('span');
        setColumnText(said, e.text);
        line.append(who, said);
        LOG_BOX.appendChild(line);
        LOG_BOX.scrollTop = LOG_BOX.scrollHeight;
    });
}


// --- GAME LOGIC & SERVER COMMUNICATION ---

// Columns in `message` are written as tags (see columnLabels.js), so a line already on
// screen still reads correctly after the numbering is switched.
function logMessage(message) {
    // Update the main status message
    setColumnText(STATUS_MSG, message);

    // Create and add the log entry to the scroll box
    const logEntry = document.createElement('p');
    setColumnText(logEntry, `> ${message}`);
    LOG_BOX.appendChild(logEntry);

    // Automatically scroll to the bottom of the log box
    LOG_BOX.scrollTop = LOG_BOX.scrollHeight;
}

function setButtonsDisabled(state) {
    NEW_GAME_BTN.disabled = state;
    // The AI and the C++ engine are single instances on the server, so while one viewer
    // has a search running nobody else may start another.
    AI_MOVE_BTN.disabled = state || engineBusyElsewhere();
    MINIMAX_MOVE_BTN.disabled = state || engineBusyElsewhere();
    UNDO_BTN.disabled = state || engineBusyElsewhere() || currentMoveIndex === 0;
}

function checkGameOver(terminalMessage = null, nonTerminalMessage = null) {
    const [value, isTerminal] = game.getValueAndTerminated(boardState);

    if (!isTerminal) {
        if (nonTerminalMessage) {
            logMessage(nonTerminalMessage);
            setButtonsDisabled(false);
        }
        return false; // Game is not over
    }
    // If a custom message is provided, use it. Otherwise, determine the winner.
    
    if (value === 0) // Draw
        logMessage("It's a draw!");
     else { // A win occurred
        if (terminalMessage) {
            logMessage(terminalMessage);
        }else{
            const winnerPlayer = game.getCurrentPlayer(boardState) === 1 ? "Player 2" : "Player 1";
            logMessage(winnerPlayer + " wins!");
        }
    }
    // When the game is over, disable moves and allow a new game to be started.
    setButtonsDisabled(true);
    NEW_GAME_BTN.disabled = false;
    UNDO_BTN.disabled = true;
    
    return true; // Game is over
}

async function startNewGame() {
    logMessage('Starting new game...');
    setButtonsDisabled(true);
    isRequestInProgress = true;

    try {
        // Reset server state for AI
        const response = await fetch('/api/new_game', { method: 'POST' });
        if (!response.ok) throw new Error('Network response was not ok');
        
        // Reset local state
        boardState = game.getInitialState();
        moveHistory = [];
        currentMoveIndex = 0;
        
        updateBoard(boardState);
        updateMoveHistory(moveHistory);
        logMessage('Your turn! Click a column or let the AI play.');

        // Everyone in the room gets the fresh board, whatever they were looking at.
        await pushShared(fullSharedState(), { log: 'started a new game.' });

    } catch (error) {
        console.error('Error starting new game:', error);
        logMessage('Error: Could not start new game.');
    } finally {
        setButtonsDisabled(false);
        isRequestInProgress = false;
    }
}

async function undoLastMove() {
    if (isRequestInProgress) return;
    if (currentMoveIndex === 0) {
        logMessage("No moves to undo.");
        return;
    }

    isRequestInProgress = true;
    setButtonsDisabled(true);
    logMessage("Undoing last move...");

    // Undo the last move in the history
    const lastMove = moveHistory.pop();
    currentMoveIndex = moveHistory.length;

    const { state } = game.getStateFromMoves(moveHistory);
    boardState = state;

    updateBoard(boardState);
    updateMoveHistory(moveHistory);

    await pushBoard({ log: `took back the move in column ${columnTag(lastMove)}.` });

    isRequestInProgress = false;
    setButtonsDisabled(false);
    logMessage(`Undid last move: ${columnTag(lastMove)}`);
}

async function handlePlayerMove(column) {
    if (isRequestInProgress) return;

    // --- PUZZLE MODE INTERCEPTION ---
    if (isPuzzleMode) {
        handlePuzzleMove(column);
        return;
    }

    if (currentMoveIndex !== moveHistory.length && !analysis?.enabled) {
        logMessage('You must be at the most recent move to play.');
        return;
    }

    const [_, isTerminalBeforeMove] = game.getValueAndTerminated(boardState);
    if (isTerminalBeforeMove) {
        logMessage('Game is over. Please start a new game.');
        return;
    }

    const validMoves = game.getValidMoves(boardState);
    if (validMoves[column] === 0) {
        logMessage('Invalid move: Column is full.');
        return;
    }

    setButtonsDisabled(true);
    logMessage('Processing your move...');

    // Apply move locally
    const dropCoords = game.getLandingPosition(boardState, column);
    if (analysis?.enabled) moveHistory = moveHistory.slice(0, currentMoveIndex);
    boardState = game.getNextState(boardState, column);
    moveHistory.push(column);
    currentMoveIndex++;

    updateBoard(boardState, dropCoords);
    updateMoveHistory(moveHistory);

    // Publish it. If someone else got their move in first this is rejected and the
    // board we are now looking at is theirs, so there is nothing more to do here.
    // The lock covers the round trip: a second click landing mid-flight would push a
    // move built on a board the server has already refused.
    isRequestInProgress = true;
    const pushed = await pushBoard({ log: `played column ${columnTag(column)}.` });
    isRequestInProgress = false;
    if (!pushed.ok) return;

    // Check for game over locally
    if (!checkGameOver('You win!', 'Your turn! Click a column or let the AI play.')) {
        // If auto-play is on, and the game is not over, trigger the appropriate AI move
        if (gameSettings.autoAIMove && !analysis?.enabled) {
            // Use a timeout to give the player a moment to see their move
            setTimeout(() => requestAIMove(), 100);
        } else if (gameSettings.autoMinimaxMove && !analysis?.enabled) {
            setTimeout(() => requestMinimaxMove(), 100);
        }
    }
}

/**
 * Play a whole engine continuation onto the shared board in one step.
 *
 * The multi-move twin of handlePlayerMove: analysis rows are continuations of the
 * position on screen, so this replaces the future exactly the same way, but pushes
 * once instead of once per move. getStateFromMoves applies the line from the viewed
 * position and stops at the first unplayable move or at game over, so a line ending
 * in mate lands on the mate rather than running past it. Reachable only from the
 * analysis panel, so the auto-opponents handlePlayerMove triggers do not apply.
 */
async function handlePlayEngineLine(line) {
    if (isRequestInProgress || isPuzzleMode || !Array.isArray(line) || !line.length) return;

    const [, isTerminalBeforeMove] = game.getValueAndTerminated(boardState);
    if (isTerminalBeforeMove) {
        logMessage('Game is over. Please start a new game.');
        return;
    }

    const base = moveHistory.slice(0, currentMoveIndex);
    const { state, appliedMoves } = game.getStateFromMoves([...base, ...line]);
    const played = appliedMoves.slice(base.length);
    if (!played.length) {
        logMessage('That line cannot be played from this position.');
        return;
    }
    const [, endedTheGame] = game.getValueAndTerminated(state);

    setButtonsDisabled(true);
    boardState = state;
    moveHistory = appliedMoves;
    currentMoveIndex = appliedMoves.length;

    // Several moves at once get no drop animation, the same as a multi-move remote
    // change; a single falling piece would misrepresent what just happened.
    updateBoard(boardState);
    updateMoveHistory(moveHistory);

    isRequestInProgress = true;
    const pushed = await pushBoard({ log: `played the engine's line: ${played.map(columnTag).join(' ')}.` });
    isRequestInProgress = false;
    if (!pushed.ok) return;

    if (played.length < line.length && !endedTheGame) {
        logMessage('The rest of the line was not playable from this position.');
    }
    checkGameOver(null, 'Your turn! Click a column or let the AI play.');
}

// function to handle the AI move request
async function requestAIMove() {
    if (isRequestInProgress || analysis?.enabled) return;

    if (previewPiece) {
        scene.remove(previewPiece);
        previewPiece = null;
    }

    if (currentMoveIndex !== moveHistory.length) {
        logMessage('You must be at the most recent move to play.');
        return;
    }

    const [__, isTerminal] = game.getValueAndTerminated(boardState);
    if (isTerminal) {
        logMessage('Game is over. Cannot make an AI move.');
        return;
    }

    if (engineBusyElsewhere()) {
        logMessage('Another viewer already has the engine running.');
        return;
    }

    isRequestInProgress = true;
    setButtonsDisabled(true);
    logMessage('AI is thinking... 🤔');
    // Claim the engine so the other viewers see why, and cannot start a second search.
    await setEngineBusy('ai');

    try {
        // Add a small delay for better UX
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // We need to make sure the server has the latest state before asking for an AI move.
        await fetch('/api/set_state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                board_state: boardState,
                move_history: moveHistory
            }),
        });

        const response = await fetch('/api/ai_move', { method: 'POST' });
        if (!response.ok) throw new Error('AI server error.');
        
        const data = await response.json();
        const move = data.move;

        // Apply the move returned by the AI
        const dropCoords = game.getLandingPosition(boardState, move);
        boardState = game.getNextState(boardState, move);
        moveHistory.push(move);
        currentMoveIndex++;

        updateBoard(boardState, dropCoords);
        updateMoveHistory(moveHistory);

        const pushed = await pushBoard({ log: `let the AI play column ${columnTag(move)}.` });
        if (!pushed.ok) return;

        if (!checkGameOver('AI wins!', 'Your turn! Click a column or let the AI play.')) {
            setButtonsDisabled(false); // Re-enable for next move
        }

    } catch (error) {
        console.error('Error during AI move:', error);
        logMessage(`Error: ${error.message}`);
        setButtonsDisabled(false); // Re-enable on error
    } finally {
        isRequestInProgress = false;
        await setEngineBusy(null);   // release the engine for the other viewers
    }
}

// function to handle the minimax move request
async function requestMinimaxMove() {
    if (isRequestInProgress || analysis?.enabled) return;

    if (previewPiece) {
        scene.remove(previewPiece);
        previewPiece = null;
    }

    if (currentMoveIndex !== moveHistory.length) {
        logMessage('You must be at the most recent move to play.');
        return;
    }

    const [__, isTerminal] = game.getValueAndTerminated(boardState);
    if (isTerminal) {
        logMessage('Game is over. Cannot make a minimax move.');
        return;
    }

    if (engineBusyElsewhere()) {
        logMessage('Another viewer already has the engine running.');
        return;
    }

    isRequestInProgress = true;
    setButtonsDisabled(true);
    logMessage('Minimax AI is thinking...');
    await setEngineBusy('minimax');

    try {
        const hexCodes = game.getStateHexCode(boardState).split(' ');
        const hex_p1 = hexCodes[0];
        const hex_p2 = hexCodes[1];

        const response = await fetch('/api/minimax_move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hex_p1, hex_p2 }),
        });

        if (!response.ok) throw new Error('Minimax server error.');

        const data = await response.json();
        const move = data.move;

        const dropCoords = game.getLandingPosition(boardState, move);
        boardState = game.getNextState(boardState, move);
        moveHistory.push(move);
        currentMoveIndex++;

        updateBoard(boardState, dropCoords);
        updateMoveHistory(moveHistory);

        const pushed = await pushBoard({ log: `let the minimax engine play column ${columnTag(move)}.` });
        if (!pushed.ok) return;

        if (!checkGameOver('Minimax AI wins!', 'Your turn! Click a column or let the AI play.')) {
            setButtonsDisabled(false);
        }

    } catch (error) {
        console.error('Error during minimax move:', error);
        logMessage(`Error: ${error.message}`);
        setButtonsDisabled(false);
    } finally {
        isRequestInProgress = false;
        await setEngineBusy(null);
    }
}

async function navigateHistory(direction) {
    const newIndex = currentMoveIndex + direction;

    if (newIndex < 0 || newIndex > moveHistory.length) {
        clearGhostPieces();
        return; // Out of bounds
    }

    currentMoveIndex = newIndex;
    const isViewingLive = currentMoveIndex === moveHistory.length;

    const movesToDisplay = moveHistory.slice(0, currentMoveIndex);
    
    // Generate state locally
    const { state } = game.getStateFromMoves(movesToDisplay);
    boardState = state;
    updateBoard(boardState);
    updateMoveHistory(moveHistory); // Redraw to update highlighting

    // Scrubbing the history is part of what the room is looking at, so it travels too.
    pushShared({ view_index: currentMoveIndex, ghosts: [] });

    if (isViewingLive) {
        logMessage('Viewing the most recent move. Your turn!');
        setButtonsDisabled(false);
    } else {
        logMessage(`Viewing move ${currentMoveIndex} of ${moveHistory.length}.`);
        setButtonsDisabled(true);
    }
}

// --- EVENT HANDLERS & ANIMATION ---

function handleMoveInputChange(event) {
    if (event.key !== 'Enter') {
        return;
    }

    const movesString = MOVE_INPUT.value.trim();
    if (!movesString) {
        return; // Do nothing if input is empty
    }

    // Moves may be separated by spaces, commas, or a mix of the two. They are read in the
    // numbering on screen, so a list copied out of the move box pastes straight back in.
    const tokens = movesString.split(/[\s,]+/).filter(t => t.length);
    const moves = tokens.map(parseColumn);
    if (moves.some(move => move === null)) {
        logMessage(`Invalid move list: expected columns ${columnRange()}, separated by spaces or commas.`);
        return;
    }

    // Immediately clear the input and show loading state
    MOVE_INPUT.value = '';
    logMessage(`Loading position from moves: ${moves.map(columnTag).join(' ')}`);
    setButtonsDisabled(true);
    isRequestInProgress = true;

    // Generate state locally
    const { state, appliedMoves } = game.getStateFromMoves(moves);
    
    if (appliedMoves.length < moves.length) {
        logMessage(`Warning: Invalid move found. Displaying state before invalid move.`);
    }

    boardState = state;
    moveHistory = appliedMoves;
    currentMoveIndex = appliedMoves.length;

    updateBoard(boardState);
    updateMoveHistory(moveHistory);

    // Loading a position replaces the board outright, so don't make it conditional on
    // the room's version -- the point is to put everyone on this position.
    pushBoard({ expect: false, log: `loaded a position: ${appliedMoves.map(columnTag).join(' ') || '(empty board)'}` });

    setButtonsDisabled(false);
    isRequestInProgress = false;


}

function handleKeyDown(event) {
    // Prevent arrow key navigation when the input is focused
    if (document.activeElement?.matches('input, select, textarea, [contenteditable="true"]')) {
        return;
    }
    if (isRequestInProgress) return;
    if (isPuzzleMode) return;   // don't let history nav disrupt an active puzzle

    if (event.key === 'ArrowLeft') {
        navigateHistory(-1);
    } else if (event.key === 'ArrowRight') {
        navigateHistory(1);
    }
}

function onWindowResize() {
    const container = document.getElementById('scene-container');
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

function onColumnClick(event) {
    if (isRequestInProgress) return;

    // Hide preview piece on click
    if (previewPiece) {
        scene.remove(previewPiece);
        previewPiece = null;
    }

    const mouse = new THREE.Vector2();
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(clickTargets);

    if (intersects.length > 0) {
        const clickedColumn = intersects[0].object.userData.column;
        if (event.button === 0) { // Left click
            handlePlayerMove(clickedColumn);
        } else if (event.button === 2) { // Right click
            handleGhostMove(clickedColumn);
        }
    } else if (event.button === 2) {
        // Right-click on empty space (not over a drop column) clears all planning ghosts.
        clearGhostPieces();
        pushShared({ ghosts: [] });
    }
}

function handleGhostMove(column) {
    const tempState = getTemporaryState();
    const landingPosition = game.getLandingPosition(tempState, column);

    if (!landingPosition) {
        logMessage('Invalid ghost move: Column is full.');
        return;
    }

    const player = game.getCurrentPlayer(tempState);
    const [depth, row, col] = landingPosition;

    const material = player === 1 ? ghostPlayer1Material : ghostPlayer2Material;

    const piece = createPieceMesh(material);
    piece.position.set(col, 3 - depth, row);
    piece.userData.isGhost = true;
    scene.add(piece);
    ghostPieces.push(piece);

    // Planning ghosts are shared: they are how two people point at a line together.
    pushShared({ ghosts: ghostCells() });
}

function getTemporaryState() {
    let tempState = JSON.parse(JSON.stringify(boardState)); // Deep copy

    ghostPieces.forEach(p => {
        const { x, y, z } = p.position;
        const boardZ = 3 - y;
        const boardY = z;
        const boardX = x;
        
        // This is a simplified player check. A more robust way might be needed
        // if ghost pieces for both players can be on the board.
        const player = (p.material === ghostPlayer1Material) ? 1 : -1;

        if (boardZ >= 0 && boardZ < 4 && boardY >= 0 && boardY < 4 && boardX >= 0 && boardX < 4) {
            tempState[boardZ][boardY][boardX] = player;
        }
    });

    return tempState;
}

function onMouseMove(event) {
    if (isRequestInProgress) return;

    const mouse = new THREE.Vector2();
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(clickTargets);

    if (intersects.length > 0) {
        const hoveredColumn = intersects[0].object.userData.column;
        showPreview(hoveredColumn);
    } else {
        if (previewPiece) {
            scene.remove(previewPiece);
            previewPiece = null;
        }
    }
}

async function showPreview(column) {
    // Calculate preview locally
    const landingPosition = game.getLandingPosition(boardState, column);

    if (!landingPosition) {
        if (previewPiece) {
            scene.remove(previewPiece);
            previewPiece = null;
        }
        return;
    }

    const player = game.getCurrentPlayer(boardState);
    const [depth, row, col] = landingPosition;

    if (previewPiece) {
        scene.remove(previewPiece);
    }

    const material = player === 1
        ? new THREE.MeshStandardMaterial({ color: player1Color, roughness: 0.5, opacity: Math.min(gameSettings.pieceOpacity, 0.5), transparent: true })
        : new THREE.MeshStandardMaterial({ color: player2Color, roughness: 0.5, opacity: Math.min(gameSettings.pieceOpacity, 0.5), transparent: true });

    previewPiece = createPieceMesh(material);
    previewPiece.position.set(col, 3 - depth, row);
    scene.add(previewPiece);
}

// --- BEST-MOVE INDICATOR ---

// Called by the analysis panel with its current top move, or null to show nothing.
function setBestMove(column) {
    bestMoveColumn = Number.isInteger(column) ? column : null;
}

// The cell the marker belongs in right now, or null if there is nothing to mark. The
// column can be unplayable on the position currently on screen (the engine analysed a
// later position, or history was rewound), in which case nothing is drawn.
function bestMoveTarget() {
    if (bestMoveColumn === null || !analysis?.enabled || isPuzzleMode) return null;
    return game.getLandingPosition(boardState, bestMoveColumn);
}

const sameCell = (a, b) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

// Whose turn it is in the position on screen. Counted off the board so a reviewed,
// imported or remote position reads correctly, and counted by hand so that running it
// every frame costs nothing (game.getCurrentPlayer allocates through flat()/filter()).
function sideToMoveOnBoard() {
    let placed = 0;
    for (let d = 0; d < 4; d++) {
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) if (boardState[d][r][c] !== 0) placed++;
        }
    }
    return placed % 2 === 0 ? 1 : -1;
}

function updateBestMoveIndicator() {
    const now = performance.now();
    // Clamp the step: a backgrounded tab resumes with an enormous gap, which would snap
    // the fade rather than animate it.
    const dt = Math.min(now - (bestMoveLastFrame || now), 100);
    bestMoveLastFrame = now;

    const target = bestMoveTarget();
    // The marker never jumps mid-breath: when the engine changes its mind it fades out
    // where it stood, and only then reappears on the new cell.
    if (sameCell(target, bestMoveCell) && target) {
        bestMovePresence = Math.min(1, bestMovePresence + dt / BEST_MOVE_SWAP_MS);
    } else {
        bestMovePresence = Math.max(0, bestMovePresence - dt / BEST_MOVE_SWAP_MS);
        if (bestMovePresence === 0) bestMoveCell = target;
    }

    if (!bestMoveCell || bestMovePresence <= 0.001) {
        if (bestMoveMesh) bestMoveMesh.visible = false;
        return;
    }

    if (!bestMoveMesh) {
        const material = new THREE.MeshStandardMaterial({
            emissiveIntensity: 0.55,
            roughness: 0.4,
            transparent: true,
            depthWrite: false,   // it is an annotation: never let it punch a hole in a piece
        });
        bestMoveMesh = new THREE.Mesh(pieceBaseGeo, material);
        bestMoveMesh.renderOrder = 2;
        scene.add(bestMoveMesh);
    }
    // Re-read every frame rather than latching it when the cell is taken up: the same
    // column can stay best across a move, leaving the marker on the very same cell while
    // the turn -- and so its colour -- has changed underneath it.
    const color = sideToMoveOnBoard() === 1 ? BEST_MOVE_LIGHT_COLOR : BEST_MOVE_DARK_COLOR;
    bestMoveMesh.material.color.setHex(color);
    bestMoveMesh.material.emissive.setHex(color);
    // The shared geometry is swapped once the FBX bead finishes loading, and the piece-size
    // setting can move under us; both are picked up here rather than on a rebuild.
    if (bestMoveMesh.geometry !== pieceBaseGeo) bestMoveMesh.geometry = pieceBaseGeo;

    const [depth, row, col] = bestMoveCell;
    bestMoveMesh.position.set(col, 3 - depth, row);

    // Smoothstep the presence so neither end of the swap has a visible corner; the breath
    // itself is a cosine, which has no corner at either extreme by construction.
    const eased = bestMovePresence * bestMovePresence * (3 - 2 * bestMovePresence);
    const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * (now % BEST_MOVE_CYCLE_MS)) / BEST_MOVE_CYCLE_MS);
    bestMoveMesh.material.opacity = eased * (BEST_MOVE_MIN_OPACITY + (BEST_MOVE_MAX_OPACITY - BEST_MOVE_MIN_OPACITY) * breath);
    bestMoveMesh.scale.setScalar(0.4 * gameSettings.pieceSize * BEST_MOVE_SCALE * (1 + 0.04 * breath));
    bestMoveMesh.visible = true;
}

function animate() {
    requestAnimationFrame(animate);
    updateDrops();
    updateBestMoveIndicator();
    updateOcclusionOverlays();
    controls.update(); // only required if controls.enableDamping = true
    renderer.render(scene, camera);
}

// --- OCCLUSION OVERLAYS ---

// A piece only reveals itself once at least this fraction of its on-screen area is
// hidden behind other pieces. Below it, a piece that is merely clipped at the edge stays
// quiet, so the highlight means "this one is genuinely buried", not "something grazes it".
const OCCLUSION_COVERAGE_THRESHOLD = 0.6;
const OCCLUSION_SAMPLES = 24;          // sample points per piece used to estimate coverage
const OCCLUSION_FADE_MS = 220;         // time for an overlay to fade fully in or out
let _ocLastFrameTime = 0;              // timestamp of the previous fade step

// Sample points spread evenly over the unit disc (a sunflower/Vogel spiral, which gives a
// far more uniform distribution than a polar grid for a small point count). Built once.
const occlusionSamplePoints = (() => {
    const points = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < OCCLUSION_SAMPLES; i++) {
        const r = Math.sqrt((i + 0.5) / OCCLUSION_SAMPLES);  // sqrt keeps the area density even
        const a = i * goldenAngle;
        points.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return points;
})();

// Scratch state, reused every frame so the per-frame pass allocates nothing. _ocDiscs
// grows to the high-water mark of pieces on the board and is then rewritten in place.
const _ocCenter = new THREE.Vector3();
const _ocEdge = new THREE.Vector3();
const _ocCamRight = new THREE.Vector3();
const _ocDiscs = [];

// Runs once per frame. Three jobs:
//  1. Keep each outline ring concentric with its piece and facing the camera, so it stays
//     aligned with the silhouette from any orbit angle. (Concentric on purpose: offsetting
//     it toward the camera would shift its projection sideways for off-centre pieces.)
//  2. Decide which pieces are buried enough to show their occlusion overlay at all.
//  3. Step each overlay's fade toward that decision, so overlays dissolve in and out.
//
// Coverage is estimated in screen space rather than by raycasting: each piece becomes a
// disc (centre + radius in aspect-corrected NDC), and a piece's sample points are tested
// against the discs of every piece nearer the camera. It is an approximation -- the bead
// is not a perfect disc -- but it only has to answer "is most of this thing hidden?", and
// at 64 pieces x 24 samples it costs a fraction of a millisecond.
function updateOcclusionOverlays() {
    // Advance the clock even when there is nothing to draw, so returning to a populated
    // board does not hand the fade one enormous first step.
    const now = performance.now();
    // Clamped: a backgrounded tab can hand back a gap of seconds, which would snap every
    // overlay to its target and defeat the point of the fade.
    const elapsed = _ocLastFrameTime ? Math.min(now - _ocLastFrameTime, 100) : 0;
    _ocLastFrameTime = now;

    if (pieceOverlays.length === 0) return;

    // The camera's world-space X axis: stepping along it from a piece's centre lands on
    // the edge of its silhouette, whichever way the camera is pointing.
    _ocCamRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const aspect = camera.aspect || 1;

    const count = pieceOverlays.length;
    for (let i = 0; i < count; i++) {
        const { piece, ring } = pieceOverlays[i];
        if (ring) {
            ring.position.copy(piece.position);
            ring.quaternion.copy(camera.quaternion);
        }

        // Distance to the camera, used to decide which pieces can occlude which.
        const depth = _ocCenter.copy(piece.position).distanceTo(camera.position);

        _ocEdge.copy(piece.position).addScaledVector(_ocCamRight, pieceSilhouetteRadius * piece.scale.x);
        _ocCenter.project(camera);
        _ocEdge.project(camera);

        const disc = _ocDiscs[i] || (_ocDiscs[i] = { x: 0, y: 0, r: 0, depth: 0 });
        // NDC is stretched to the viewport, so scale x by the aspect ratio to get a space
        // in which a circle on screen is a circle here.
        disc.x = _ocCenter.x * aspect;
        disc.y = _ocCenter.y;
        disc.r = Math.abs(_ocEdge.x - _ocCenter.x) * aspect;
        disc.depth = depth;
    }

    const needed = OCCLUSION_COVERAGE_THRESHOLD * OCCLUSION_SAMPLES;
    const fadeStep = OCCLUSION_FADE_MS > 0 ? elapsed / OCCLUSION_FADE_MS : 1;

    for (let i = 0; i < count; i++) {
        const disc = _ocDiscs[i];
        let blocked = 0;

        for (let s = 0; s < OCCLUSION_SAMPLES; s++) {
            const sample = occlusionSamplePoints[s];
            const px = disc.x + sample[0] * disc.r;
            const py = disc.y + sample[1] * disc.r;
            for (let j = 0; j < count; j++) {
                if (j === i) continue;
                const other = _ocDiscs[j];
                if (other.depth >= disc.depth) continue;   // level with or behind: cannot hide it
                const dx = px - other.x;
                const dy = py - other.y;
                if (dx * dx + dy * dy <= other.r * other.r) { blocked++; break; }
            }
        }

        // Ease toward the target rather than snapping to it, so a piece sliding behind
        // another (or the camera orbiting past the threshold) dissolves in instead of
        // blinking on. The threshold itself stays a hard boolean -- only its presentation
        // is smoothed.
        const overlay = pieceOverlays[i];
        const target = blocked >= needed ? 1 : 0;
        let fade = overlay.fade;
        if (fade < target) fade = Math.min(target, fade + fadeStep);
        else if (fade > target) fade = Math.max(target, fade - fadeStep);
        overlay.fade = fade;
        occlusionFade.set(overlay.key, fade);
        applyOverlayFade(overlay);
    }
}

// Push an overlay's fade value out to its meshes.
function applyOverlayFade(overlay) {
    // Smoothstep: eases out of 0 and into 1, so neither end of the fade has the visible
    // corner a straight linear ramp leaves.
    const f = overlay.fade;
    const eased = f * f * (3 - 2 * f);
    const visible = eased > 0.001;

    if (overlay.mask) {
        overlay.mask.visible = visible;
        overlay.mask.material.opacity = gameSettings.maskOpacity * eased;
    }
    if (overlay.ring) {
        overlay.ring.visible = visible;
        overlay.ring.material.opacity = eased;
    }
}

// Advance any in-flight piece drops. Uses an ease-in (accelerating) curve so
// pieces fall as if pulled down by gravity.
function updateDrops() {
    if (activeDrops.length === 0) return;
    const now = performance.now();
    for (let i = activeDrops.length - 1; i >= 0; i--) {
        const d = activeDrops[i];
        const t = (now - d.start) / d.duration;
        if (t >= 1) {
            d.mesh.position.y = d.endY;
            activeDrops.splice(i, 1);
        } else {
            const eased = t * t; // ease-in
            d.mesh.position.y = d.startY + (d.endY - d.startY) * eased;
        }
    }
    // The winning bar is built as soon as the board updates, but showing it while the
    // deciding piece is still in the air gives the win away early -- reveal it the moment
    // the last piece lands.
    if (activeDrops.length === 0) {
        winHighlights.forEach(m => { m.visible = true; });
    }
}

// --- PUZZLE MODE FUNCTIONS ---

// ---- File-uploaded puzzles ----

function handlePuzzleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const parsedPuzzles = parsePuzzleFile(e.target.result);
        if (parsedPuzzles.length > 0) {
            puzzles = parsedPuzzles;
            puzzleSource = 'file';
            enterPuzzleMode();
            loadPuzzle(0);
        } else {
            alert("No valid puzzles found in the file.");
        }
    };
    reader.readAsText(file);
}

function isBoardCodeLine(line) {
    const toks = line.split(/\s+/).filter(t => t.length);
    if (toks.length !== 2) return false;
    if (!toks.every(t => /^[0-9a-fA-F]+$/.test(t))) return false;
    return toks.some(t => t.length > 2); // move values are 0-15 (<= 2 chars)
}

function parseMoveLine(line) {
    const toks = line.split(/[\s,]+/).filter(t => t.length);
    const out = [];
    for (const t of toks) {
        const v = Number(t);
        if (!Number.isInteger(v)) return null;
        out.push(v);
    }
    return out;
}

// Handles both the old 2-line format (history / solution) and the engine's new
// 3-line format (board code / history / solution).
function parsePuzzleFile(text) {
    const raw = text.split('\n').map(l => l.trim());
    const parsed = [];
    let i = 0;
    const n = raw.length;
    while (i < n) {
        if (raw[i] === '') { i++; continue; }
        let history, solution;
        if (isBoardCodeLine(raw[i])) {
            if (i + 2 >= n) break;
            history = raw[i + 1] === '' ? [] : parseMoveLine(raw[i + 1]);
            solution = parseMoveLine(raw[i + 2]);
            i += 3;
        } else {
            if (i + 1 >= n) break;
            history = parseMoveLine(raw[i]);
            solution = parseMoveLine(raw[i + 1]);
            i += 2;
        }
        if (history && solution && solution.length && solution.length % 2 === 1 &&
            solution.every(m => m >= 0 && m < 16) && history.every(m => m >= 0 && m < 16)) {
            parsed.push({ history, solution, mate: (solution.length + 1) / 2 });
        }
    }
    return parsed;
}

// ---- Engine puzzles (server-sourced) ----

function openEnginePuzzleSetup() {
    document.getElementById('engine-puzzle-setup').classList.remove('hidden');
    document.getElementById('button-container').classList.add('hidden');
    document.getElementById('engine-puzzle-btn').classList.add('hidden');
    document.getElementById('upload-puzzle-btn').classList.add('hidden');
    refreshMateCounts();
    // The engine keeps generating & verifying puzzles in the background the whole
    // time the puzzle UI is open -- no need to press a button.
    startBackgroundGeneration();
}

function closeEnginePuzzleSetup() {
    document.getElementById('engine-puzzle-setup').classList.add('hidden');
    if (!isPuzzleMode) {
        stopBackgroundGeneration();   // left the puzzle area entirely -> free the engine
        document.getElementById('button-container').classList.remove('hidden');
        document.getElementById('engine-puzzle-btn').classList.remove('hidden');
        document.getElementById('upload-puzzle-btn').classList.remove('hidden');
    }
}

function renderMateHint(counts, categoryCounts) {
    if (counts) lastCounts = counts;
    if (categoryCounts) lastCategoryCounts = categoryCounts;
    const cc = lastCategoryCounts || {};
    const sel = CATEGORIES.find(c => c.key === selectedCategory) || CATEGORIES[0];
    const n = cc[selectedCategory] || 0;
    const summary = CATEGORIES.map(c => `${c.label.split(' ')[0]} ${cc[c.key] || 0}`).join('  ·  ');
    document.getElementById('mate-count-hint').textContent =
        `${n} puzzles (${sel.range_label}) available   —   ${summary}`;
}

function selectCategory(key) {
    selectedCategory = key;
    document.querySelectorAll('.cat-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.category === key);
    });
    renderMateHint();
}

async function refreshMateCounts() {
    try {
        const res = await fetch('/api/puzzle/counts');
        const data = await res.json();
        if (Array.isArray(data.categories) && data.categories.length) CATEGORIES = data.categories;
        renderMateHint(data.counts || {}, data.category_counts || {});
    } catch (e) { /* non-critical */ }
}

async function startEnginePuzzle(category) {
    if (isRequestInProgress) return;
    isRequestInProgress = true;
    const label = categoryLabel(category);
    logMessage(`Fetching a ${label.toLowerCase()} from the engine...`);
    try {
        const res = await fetch(`/api/puzzle?category=${encodeURIComponent(category)}`);
        const data = await res.json();
        if (data.category_counts) renderMateHint(data.counts, data.category_counts);
        if (!res.ok || data.empty) {
            logMessage(data.error || 'No puzzle available.');
            document.getElementById('generate-status').textContent =
                `No ${label} puzzles yet — the engine is generating; try again shortly.`;
            return;
        }
        puzzles = [{ history: data.history, solution: data.solution, mate: data.mate,
                 steps: data.steps, goal: data.goal, id: data.id }];
        puzzleSource = 'engine';
        selectedCategory = category;
        if (!isPuzzleMode) enterPuzzleMode();
        loadPuzzle(0);
    } catch (e) {
        logMessage('Error fetching puzzle: ' + e.message);
    } finally {
        isRequestInProgress = false;
    }
}

function updateGenerateButton() {
    const btn = document.getElementById('generate-puzzle-btn');
    if (btn) btn.textContent = generationRunning ? '⏸ Pause generating' : '▶ Resume generating';
}

function toggleGeneration() {
    if (generationRunning) stopBackgroundGeneration();
    else startBackgroundGeneration();
}

async function startBackgroundGeneration() {
    generationRunning = true;
    updateGenerateButton();
    startGenerationPolling();
    try {
        await fetch('/api/puzzle/generate/start', { method: 'POST' });
    } catch (e) { /* ignore */ }
}

async function stopBackgroundGeneration() {
    stopGenerationPolling();
    generationRunning = false;
    updateGenerateButton();
    try {
        const response = await fetch('/api/puzzle/generate/stop', { method: 'POST' });
        const data = await response.json();
        if (!generationRunning) {
            const message = data.status?.message || 'Generation paused.';
            for (const id of ['generate-status', 'puzzle-gen-indicator']) {
                const indicator = document.getElementById(id);
                if (indicator) indicator.textContent = message;
            }
        }
    } catch (e) { /* ignore */ }
}

function startGenerationPolling() {
    stopGenerationPolling();
    pollGenerationStatus();
    generationPollTimer = setInterval(pollGenerationStatus, 2500);
}

function stopGenerationPolling() {
    if (generationPollTimer) {
        clearInterval(generationPollTimer);
        generationPollTimer = null;
    }
}

async function pollGenerationStatus() {
    try {
        const res = await fetch('/api/puzzle/generate/status');
        const data = await res.json();
        const st = data.status || {};
        generationRunning = !!st.running;
        updateGenerateButton();
        renderMateHint(st.counts, st.category_counts);
        const msg = st.running
            ? `⚙️ Engine generating in the background… +${st.session_added || 0} puzzles this session`
            : (st.message || 'Generation paused.');
        const genStatus = document.getElementById('generate-status');
        if (genStatus) genStatus.textContent = msg;
        const genIndicator = document.getElementById('puzzle-gen-indicator');
        if (genIndicator) genIndicator.textContent = msg;
    } catch (e) { /* keep polling */ }
}

// ---- Shared puzzle mode machinery ----

function enterPuzzleMode() {
    if (analysis?.enabled) analysis.setEnabled(false);
    isPuzzleMode = true;
    currentPuzzleIndex = 0;
    document.getElementById('engine-puzzle-setup').classList.add('hidden');
    document.getElementById('puzzle-controls').classList.remove('hidden');
    document.getElementById('button-container').classList.add('hidden');
    // Keep the move-history panel visible in puzzle mode: it holds the "copy moves"
    // and "copy state hex" buttons, which are useful for analysing the position.
    document.getElementById('engine-puzzle-btn').classList.add('hidden');
    document.getElementById('upload-puzzle-btn').classList.add('hidden');
}

// Tear the puzzle UI down and go back to the normal game controls. Split out of
// exitPuzzleMode so a viewer who is told "the room left Puzzle Mode" can follow along
// without also starting a game of its own.
function leavePuzzleUI() {
    isPuzzleMode = false;
    puzzles = [];
    puzzleSource = null;
    currentPuzzleSolved = false;
    stopBackgroundGeneration();   // leaving Puzzle Mode frees the engine immediately

    document.getElementById('puzzle-controls').classList.add('hidden');
    document.getElementById('engine-puzzle-setup').classList.add('hidden');
    document.getElementById('button-container').classList.remove('hidden');
    document.getElementById('move-history-container').classList.remove('hidden');
    document.getElementById('engine-puzzle-btn').classList.remove('hidden');
    document.getElementById('upload-puzzle-btn').classList.remove('hidden');

    document.getElementById('puzzle-file-input').value = '';
}

function exitPuzzleMode() {
    leavePuzzleUI();
    startNewGame();   // pushes the empty board, taking the whole room out of Puzzle Mode
}

function handlePrevPuzzle() {
    if (puzzleSource === 'engine') return;   // engine puzzles have no back-history
    loadPuzzle(currentPuzzleIndex - 1);
}

function handleNextPuzzle() {
    if (puzzleSource === 'engine') {
        startEnginePuzzle(selectedCategory); // fetch a fresh random puzzle in the same category
    } else {
        loadPuzzle(currentPuzzleIndex + 1);
    }
}

function updatePuzzleInfo() {
    const title = document.getElementById('puzzle-title');
    const status = document.getElementById('puzzle-status');
    const prev = document.getElementById('prev-puzzle-btn');
    const next = document.getElementById('next-puzzle-btn');

    if (puzzleSource === 'engine') {
        // Deliberately do NOT show the objective mate distance -- the point of the puzzle
        // is to find the win without knowing how many moves it takes.
        title.textContent = categoryLabel(selectedCategory);
        status.textContent = currentPuzzleSolved ? 'Solved ✓'
            : (puzzles[currentPuzzleIndex]?.goal === 'draw' ? 'Find the only draw' : 'Find the only win');
        prev.disabled = true;
        next.disabled = false;
        prev.title = 'Not available for engine puzzles';
        next.title = 'New puzzle';
    } else {
        title.textContent = 'Puzzle';
        status.textContent = `${currentPuzzleIndex + 1} / ${puzzles.length}`;
        prev.disabled = (currentPuzzleIndex === 0);
        next.disabled = (currentPuzzleIndex === puzzles.length - 1);
        prev.title = 'Previous Puzzle';
        next.title = 'Next Puzzle';
    }
}

function loadPuzzle(index) {
    if (index < 0 || index >= puzzles.length) return;

    currentPuzzleIndex = index;
    const puzzle = puzzles[currentPuzzleIndex];
    currentPuzzleSolutionIndex = 0;
    currentPuzzleSolved = false;

    // Set board state from the puzzle's move history
    const { state } = game.getStateFromMoves(puzzle.history);
    boardState = state;
    moveHistory = [...puzzle.history];
    currentMoveIndex = moveHistory.length;
    updateBoard(boardState);
    updateMoveHistory(moveHistory);   // keep the (visible) history panel in sync

    updatePuzzleInfo();

    const colorName = game.getCurrentPlayer(boardState) === 1 ? PLAYER1_NAME : PLAYER2_NAME;
    const label = puzzleSource === 'engine'
        ? categoryLabel(selectedCategory)
        : `Puzzle ${index + 1}`;
    logMessage(`${label} — ${colorName} to move.`);

    // A new puzzle replaces whatever the room was on, so this push is unconditional and
    // carries the puzzle set itself (the only place that field is sent).
    pushShared(fullSharedState(), { log: `opened ${label.toLowerCase()} — ${colorName} to move.` });
}

async function handlePuzzleMove(column) {
    if (currentPuzzleSolved) {
        logMessage('Puzzle already solved — click > for a new one.');
        return;
    }
    const puzzle = puzzles[currentPuzzleIndex];
    const expectedMove = puzzle.solution[currentPuzzleSolutionIndex];

    if (column !== expectedMove) {
        logMessage(`Not the ${puzzle.goal === 'draw' ? 'drawing' : 'winning'} move — try again (↻ to reset, 💡 for the solution).`);
        return;
    }

    // Correct solver move
    logMessage('Correct!');
    const dropCoords = game.getLandingPosition(boardState, column);
    boardState = game.getNextState(boardState, column);
    moveHistory.push(column);
    currentMoveIndex = moveHistory.length;
    updateBoard(boardState, dropCoords);
    updateMoveHistory(moveHistory);
    currentPuzzleSolutionIndex++;
    pushBoard({ log: `found column ${columnTag(column)}.` });

    if (currentPuzzleSolutionIndex >= puzzle.solution.length) {
        finishPuzzle();
        return;
    }

    // Opponent's forced reply (from the stored solution line)
    const opponentMove = puzzle.solution[currentPuzzleSolutionIndex];
    isRequestInProgress = true;   // lock input during the reply animation
    await new Promise(resolve => setTimeout(resolve, 450));
    const oppDropCoords = game.getLandingPosition(boardState, opponentMove);
    boardState = game.getNextState(boardState, opponentMove);
    moveHistory.push(opponentMove);
    currentMoveIndex = moveHistory.length;
    updateBoard(boardState, oppDropCoords);
    updateMoveHistory(moveHistory);
    currentPuzzleSolutionIndex++;
    isRequestInProgress = false;
    pushBoard({ expect: false });

    if (currentPuzzleSolutionIndex >= puzzle.solution.length) {
        finishPuzzle();
    } else {
        logMessage(`Opponent replied (column ${columnTag(opponentMove)}). Your move — find the ${puzzle.goal === 'draw' ? 'draw' : 'win'}!`);
    }
}

function finishPuzzle() {
    currentPuzzleSolved = true;
    updatePuzzleInfo();
    logMessage('Puzzle solved! 🎉  Click > for a new one.');
    pushBoard({ expect: false, log: 'solved the puzzle! 🎉' });
}

async function showSolution() {
    if (!isPuzzleMode || currentPuzzleSolved) return;
    const puzzle = puzzles[currentPuzzleIndex];
    logMessage('Showing the solution...');
    isRequestInProgress = true;
    for (let i = currentPuzzleSolutionIndex; i < puzzle.solution.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 450));
        const dropCoords = game.getLandingPosition(boardState, puzzle.solution[i]);
        boardState = game.getNextState(boardState, puzzle.solution[i]);
        moveHistory.push(puzzle.solution[i]);
        currentMoveIndex = moveHistory.length;
        updateBoard(boardState, dropCoords);
        updateMoveHistory(moveHistory);
        currentPuzzleSolutionIndex = i + 1;
        // Pushed a move at a time so the other viewers watch it play out, not jump.
        pushBoard({ expect: false });
    }
    currentPuzzleSolutionIndex = puzzle.solution.length;
    currentPuzzleSolved = true;
    isRequestInProgress = false;
    updatePuzzleInfo();
    logMessage('Solution shown. Click > for a new puzzle.');
    pushBoard({ expect: false, log: 'revealed the solution.' });
}

// --- START ---
// The piece model must be in place before the first updateBoard, so init() waits on it.
// A failure is non-fatal: pieceBaseGeo stays a unit sphere and the game runs as before.
loadPieceModel(PIECE_MODEL_URL)
    .catch((err) => console.warn(`Could not load ${PIECE_MODEL_URL}; falling back to spheres.`, err))
    .finally(() => init());