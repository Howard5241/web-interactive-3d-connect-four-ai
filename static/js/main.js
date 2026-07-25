import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ConnectFour3D } from './gameLogic.js';

// --- GLOBAL VARIABLES ---
let scene, camera, renderer, controls;
let game; // Game logic instance
let boardState; // Current state of the board
let clickTargets = []; // Invisible planes for detecting clicks
let pieces = []; // To hold the visible game pieces
let ghostPieces = []; // To hold the ghost pieces for planning
let previewPiece = null; // To hold the semi-transparent preview piece
let isRequestInProgress = false; // Prevents multiple clicks while waiting for the server
let player1Color = 0xffdc00; // Yellow
let player2Color = 0xf50000; // Red
let player1GhostColor = 0xfff19c; // Yellow (ghost)
let player2GhostColor = 0xff7575; // Red (ghost)
let player1OutlineColor = 0xfff27a; // Yellow (occlusion outline)
let player2OutlineColor = 0xff6b6b; // Red (occlusion outline)
let ghostPlayer1Material, ghostPlayer2Material;

// Camera-facing outline rings, shown only where a piece is hidden behind another.
let pieceOutlines = []; // [{ ring, piece }]

// DOM Elements (will be assigned in init)
let STATUS_MSG, NEW_GAME_BTN, AI_MOVE_BTN, MINIMAX_MOVE_BTN, LOG_BOX, MOVE_HISTORY_BOX, MOVE_INPUT, COPY_HEX_BTN, COPY_MOVES_BTN, UNDO_BTN;
let SETTINGS_BTN, SETTINGS_MODAL_OVERLAY, CLOSE_SETTINGS_BTN;
let PIECE_SIZE_SLIDER, PIECE_SIZE_VALUE, PIECE_OPACITY_SLIDER, PIECE_OPACITY_VALUE, AUTO_AI_TOGGLE, AUTO_MINIMAX_TOGGLE, DROP_ANIMATION_TOGGLE;
let OUTLINE_THICKNESS_SLIDER, OUTLINE_THICKNESS_VALUE;

let gameSettings = {
    pieceSize: 1.0,
    pieceOpacity: 1.0,
    autoAIMove: false,
    autoMinimaxMove: false,
    dropAnimation: true,
    outlineThickness: 0.05   // occlusion outline width, as a fraction of the piece radius (0 = off)
};

// --- DROP ANIMATION ---
let activeDrops = [];            // in-flight piece drops: { mesh, startY, endY, start, duration }
const DROP_SPAWN_Y = 6.5;        // fixed height above the grid where a played piece spawns
const DROP_DURATION_MS = 450;    // time for a piece to fall to its cell

let moveHistory = [];
let currentMoveIndex = 0;

// --- PUZZLE MODE VARIABLES ---
let isPuzzleMode = false;
let puzzles = [];
let currentPuzzleIndex = 0;
let currentPuzzleSolutionIndex = 0;
let puzzleSource = null;          // 'file' | 'engine'
let selectedCategory = 'quick';  // chosen difficulty category for engine puzzles
// Category definitions (mirrors puzzle_bank.CATEGORIES); refreshed from the server.
let CATEGORIES = [
    { key: 'quick',   label: 'Quick win',  range_label: 'mate in 1–3',  min: 1,  max: 3 },
    { key: 'medium',  label: 'Medium win', range_label: 'mate in 4–5',  min: 4,  max: 5 },
    { key: 'long',    label: 'Long win',   range_label: 'mate in 6–11', min: 6,  max: 11 },
    { key: 'endgame', label: 'Endgame',    range_label: 'mate in 12+',  min: 12, max: null },
];
const categoryLabel = (key) => (CATEGORIES.find(c => c.key === key) || {}).label || key;
let currentPuzzleSolved = false;
let generationPollTimer = null;  // interval id while a background generation runs
let generationRunning = false;   // is the engine currently auto-generating?
let lastCounts = {};             // most recent per-mate bank counts
let lastCategoryCounts = {};     // most recent per-category bank counts

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

    window.addEventListener('keydown', handleKeyDown);
    MOVE_INPUT.addEventListener('keydown', handleMoveInputChange);

    // Start Animation Loop
    animate();
}

async function copyMoveHistory() {
    const movesString = moveHistory.slice(0, currentMoveIndex).join(' ');
    try {
        await navigator.clipboard.writeText(movesString);
        logMessage(`Copied moves to clipboard: ${movesString}`);
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
        // Horizontal lines (along X and Z axes for each layer)
        for (let j = 0; j <= size; j++) {
            points.push(new THREE.Vector3(offset, offset + i, offset + j));
            points.push(new THREE.Vector3(offset + size, offset + i, offset + j));
            points.push(new THREE.Vector3(offset + i, offset, offset + j));
            points.push(new THREE.Vector3(offset + i, offset + size, offset + j));
            points.push(new THREE.Vector3(offset + i, offset + j, offset));
            points.push(new THREE.Vector3(offset + i, offset + j, offset + size));
        }
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.LineSegments(geometry, material);
    scene.add(line);
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
    return sprite;
}

// Label the four bottom-layer corner columns (0, 3, 12, 15). Each number sits
// diagonally outside its corner cell so it reads as belonging to that column.
// A column index maps to grid coords: x = col % 4, z = floor(col / 4).
function drawCornerLabels() {
    const out = 1.2; // how far outside the grid (grid spans -0.5..3.5) to place labels
    const labels = [
        { n: 0,  x: -out,     z: -out },     // corner cell (x=0, z=0): to the left & front
        { n: 3,  x: 3 + out,  z: -out },     // corner cell (x=3, z=0)
        { n: 12, x: -out,     z: 3 + out },  // corner cell (x=0, z=3)
        { n: 15, x: 3 + out,  z: 3 + out },  // corner cell (x=3, z=3)
    ];
    for (const l of labels) {
        const sprite = makeTextSprite(String(l.n));
        sprite.position.set(l.x, 0, l.z); // y = 0 is the bottom layer
        scene.add(sprite);
    }
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
    // Any in-flight drops reference pieces we are about to remove -- drop them.
    activeDrops = [];

    // Clear existing pieces
    pieces.forEach(p => scene.remove(p));
    pieces = [];

    // Clear occlusion outlines (rebuilt alongside the pieces below)
    pieceOutlines.forEach(o => scene.remove(o.ring));
    pieceOutlines = [];

    clearGhostPieces();

    // Also remove the preview piece when the board updates
    if (previewPiece) {
        scene.remove(previewPiece);
        previewPiece = null;
    }

    const pieceRadius = 0.4 * gameSettings.pieceSize;
    const pieceGeo = new THREE.SphereGeometry(pieceRadius, 32, 32);

    const isTransparent = gameSettings.pieceOpacity < 1.0;

    // Outline ring geometry: its OUTER edge sits at the silhouette and it extends
    // INWARD by the chosen thickness, so the outline never spills past the piece's own
    // image. Self-occlusion is prevented by per-piece stencil ids (below), not by the
    // ring's placement, so it can safely reach the edge. Skipped when thickness is 0.
    const outlineThickness = gameSettings.outlineThickness;
    const showOutlines = outlineThickness > 0;
    const outlineGeo = showOutlines
        ? new THREE.RingGeometry(Math.max(0, pieceRadius * (1 - outlineThickness)), pieceRadius, 48)
        : null;

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
                    const piece = new THREE.Mesh(pieceGeo, material);
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

                    // Occlusion outline: follows the piece and faces the camera (see updateOutlines).
                    if (showOutlines) {
                        const outlineMat = new THREE.MeshBasicMaterial({
                            color: (pieceValue === 1) ? player1OutlineColor : player2OutlineColor,
                            side: THREE.DoubleSide,
                            transparent: true,
                            depthTest: true,
                            depthFunc: THREE.GreaterDepth,   // draw only where behind other geometry
                            depthWrite: false,
                            // ...and only where the front-most piece is a different piece.
                            stencilWrite: true,
                            stencilRef: stencilId,
                            stencilFunc: THREE.NotEqualStencilFunc,
                            stencilFail: THREE.KeepStencilOp,
                            stencilZFail: THREE.KeepStencilOp,
                            stencilZPass: THREE.KeepStencilOp
                        });
                        const outlineRing = new THREE.Mesh(outlineGeo, outlineMat);
                        outlineRing.position.copy(piece.position);
                        outlineRing.renderOrder = 999;
                        scene.add(outlineRing);
                        pieceOutlines.push({ ring: outlineRing, piece });
                    }
                }
            }
        }
    }
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

        moveBox.textContent = move;
        MOVE_HISTORY_BOX.appendChild(moveBox);
    });
    MOVE_HISTORY_BOX.scrollTop = MOVE_HISTORY_BOX.scrollHeight;
}


// --- GAME LOGIC & SERVER COMMUNICATION ---

function logMessage(message) {
    // Update the main status message
    STATUS_MSG.textContent = message;

    // Create and add the log entry to the scroll box
    const logEntry = document.createElement('p');
    logEntry.textContent = `> ${message}`;
    LOG_BOX.appendChild(logEntry);

    // Automatically scroll to the bottom of the log box
    LOG_BOX.scrollTop = LOG_BOX.scrollHeight;
}

function setButtonsDisabled(state) {
    NEW_GAME_BTN.disabled = state;
    AI_MOVE_BTN.disabled = state;
    MINIMAX_MOVE_BTN.disabled = state;
    UNDO_BTN.disabled = state || currentMoveIndex === 0;
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

    isRequestInProgress = false;
    setButtonsDisabled(false);
    logMessage(`Undid last move: ${lastMove}`);
}

async function handlePlayerMove(column) {
    if (isRequestInProgress) return;

    // --- PUZZLE MODE INTERCEPTION ---
    if (isPuzzleMode) {
        handlePuzzleMove(column);
        return;
    }

    if (currentMoveIndex !== moveHistory.length) {
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
    boardState = game.getNextState(boardState, column);
    moveHistory.push(column);
    currentMoveIndex++;

    updateBoard(boardState, dropCoords);
    updateMoveHistory(moveHistory);

    // Check for game over locally
    if (!checkGameOver('You win!', 'Your turn! Click a column or let the AI play.')) {
        // If auto-play is on, and the game is not over, trigger the appropriate AI move
        if (gameSettings.autoAIMove) {
            // Use a timeout to give the player a moment to see their move
            setTimeout(() => requestAIMove(), 100);
        } else if (gameSettings.autoMinimaxMove) {
            setTimeout(() => requestMinimaxMove(), 100);
        }
    }
}

// function to handle the AI move request
async function requestAIMove() {
    if (isRequestInProgress) return;

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

    isRequestInProgress = true;
    setButtonsDisabled(true);
    logMessage('AI is thinking... 🤔');

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

        if (!checkGameOver('AI wins!', 'Your turn! Click a column or let the AI play.')) {
            setButtonsDisabled(false); // Re-enable for next move
        }

    } catch (error) {
        console.error('Error during AI move:', error);
        logMessage(`Error: ${error.message}`);
        setButtonsDisabled(false); // Re-enable on error
    } finally {
        isRequestInProgress = false;
    }
}

// function to handle the minimax move request
async function requestMinimaxMove() {
    if (isRequestInProgress) return;

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

    isRequestInProgress = true;
    setButtonsDisabled(true);
    logMessage('Minimax AI is thinking...');

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

        if (!checkGameOver('Minimax AI wins!', 'Your turn! Click a column or let the AI play.')) {
            setButtonsDisabled(false);
        }

    } catch (error) {
        console.error('Error during minimax move:', error);
        logMessage(`Error: ${error.message}`);
        setButtonsDisabled(false);
    } finally {
        isRequestInProgress = false;
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

    const moves = movesString.split(/\s+/).map(Number);

    // Immediately clear the input and show loading state
    MOVE_INPUT.value = '';
    logMessage(`Loading position from moves: ${movesString}`);
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

    setButtonsDisabled(false);
    isRequestInProgress = false;

    
}

function handleKeyDown(event) {
    // Prevent arrow key navigation when the input is focused
    if (document.activeElement === MOVE_INPUT) {
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
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function onColumnClick(event) {
    if (isRequestInProgress) return;

    // Hide preview piece on click
    if (previewPiece) {
        scene.remove(previewPiece);
        previewPiece = null;
    }

    const mouse = new THREE.Vector2();
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

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

    const pieceRadius = 0.4 * gameSettings.pieceSize;
    const pieceGeo = new THREE.SphereGeometry(pieceRadius, 32, 32);
    const material = player === 1 ? ghostPlayer1Material : ghostPlayer2Material;

    const piece = new THREE.Mesh(pieceGeo, material);
    piece.position.set(col, 3 - depth, row);
    piece.userData.isGhost = true;
    scene.add(piece);
    ghostPieces.push(piece);
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
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

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

    const pieceRadius = 0.4 * gameSettings.pieceSize;
    const pieceGeo = new THREE.SphereGeometry(pieceRadius, 32, 32);
    const material = player === 1 
        ? new THREE.MeshStandardMaterial({ color: player1Color, roughness: 0.5, opacity: Math.min(gameSettings.pieceOpacity, 0.5), transparent: true })
        : new THREE.MeshStandardMaterial({ color: player2Color, roughness: 0.5, opacity: Math.min(gameSettings.pieceOpacity, 0.5), transparent: true });

    previewPiece = new THREE.Mesh(pieceGeo, material);
    previewPiece.position.set(col, 3 - depth, row);
    scene.add(previewPiece);
}

function animate() {
    requestAnimationFrame(animate);
    updateDrops();
    updateOutlines();
    controls.update(); // only required if controls.enableDamping = true
    renderer.render(scene, camera);
}

// Keep each occlusion outline concentric with its piece and facing the camera, so the
// ring stays aligned with the sphere's circular silhouette from any orbit angle.
// (The ring is kept concentric on purpose: offsetting it toward the camera would shift
// its projection sideways for off-centre pieces and clip into the sphere as a crescent.)
function updateOutlines() {
    if (pieceOutlines.length === 0) return;
    for (const { ring, piece } of pieceOutlines) {
        ring.position.copy(piece.position);
        ring.quaternion.copy(camera.quaternion);
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
    const toks = line.split(/\s+/).filter(t => t.length);
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
        `${n} ${sel.label} puzzles (${sel.range_label}) available   —   ${summary}`;
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
    logMessage(`Fetching a ${label} puzzle from the engine...`);
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
        puzzles = [{ history: data.history, solution: data.solution, mate: data.mate, id: data.id }];
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
        await fetch('/api/puzzle/generate/stop', { method: 'POST' });
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

function exitPuzzleMode() {
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
    startNewGame();
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
        status.textContent = currentPuzzleSolved ? 'Solved ✓' : 'Your move';
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

    const colorName = game.getCurrentPlayer(boardState) === 1 ? 'Yellow' : 'Red';
    const label = puzzleSource === 'engine'
        ? categoryLabel(selectedCategory)
        : `Puzzle ${index + 1}`;
    logMessage(`${label} — ${colorName} to move.`);
}

async function handlePuzzleMove(column) {
    if (currentPuzzleSolved) {
        logMessage('Puzzle already solved — click > for a new one.');
        return;
    }
    const puzzle = puzzles[currentPuzzleIndex];
    const expectedMove = puzzle.solution[currentPuzzleSolutionIndex];

    if (column !== expectedMove) {
        logMessage('Not the winning move — try again (↻ to reset, 💡 for the solution).');
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

    if (currentPuzzleSolutionIndex >= puzzle.solution.length) {
        finishPuzzle();
    } else {
        logMessage(`Opponent replied (column ${opponentMove}). Your move — find the win!`);
    }
}

function finishPuzzle() {
    currentPuzzleSolved = true;
    updatePuzzleInfo();
    logMessage('Puzzle solved! 🎉  Click > for a new one.');
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
    }
    currentPuzzleSolutionIndex = puzzle.solution.length;
    currentPuzzleSolved = true;
    isRequestInProgress = false;
    updatePuzzleInfo();
    logMessage('Solution shown. Click > for a new puzzle.');
}

// --- START ---
init();