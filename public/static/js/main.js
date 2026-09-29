import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ConnectFour3D } from './gameLogic.js';
import { RoomSync } from './sync.js';
import { bankSummary, randomPuzzle } from './puzzleBank.js';
import { AnalysisPanel } from './analysis.js';
import { bestMove } from './engine.js';
import { aiMove } from './nnAgent.js';
import {
    columnRange, columnTag, formatColumn, formatColumns,
    onColumnNumberingChange, parseColumn, setColumnText, setOneIndexed,
} from './columnLabels.js';

let analysis = null;

let scene, camera, renderer, controls;
let game;
let boardState;
let clickTargets = [];       // invisible planes above each column, for picking
let pieces = [];
let ghostPieces = [];        // right-click planning pieces
let previewPiece = null;     // hover preview
let previewKey = null;       // `${cell}|${player}` the preview was built for
let isRequestInProgress = false;

// Piece colours tint the textures (the shader multiplies them), so a tint can only darken
// its map. Ghost and outline colours are untextured.
const player1Color = 0xfff8ef;
const player2Color = 0xb4794a;
const player1GhostColor = 0xffc98a;
const player2GhostColor = 0xb0480a;
const player1OutlineColor = 0xfff6e8;
const player2OutlineColor = 0xd99760;
const PLAYER1_NAME = 'Light orange';
const PLAYER2_NAME = 'Dark orange';
let ghostPlayer1Material, ghostPlayer2Material;

// Per-piece occlusion overlays: `mask` is a copy of the piece drawn where it is hidden,
// `ring` a camera-facing outline at its silhouette. See updateOcclusionOverlays.
let pieceOverlays = [];      // [{ piece, mask, ring, key, fade }]

let winHighlights = [];

// Ghost lines: right-drag from one piece to another traces the four-in-a-row through both.
let ghostLineCells = [];     // [{ a: [z,y,x], b: [z,y,x] }], the two ends of each line
let ghostLineMeshes = [];
let lineDrag = null;         // { cell, x, y } of the right-press
let lineDragPreview = null;  // { key, mesh }
const GHOST_LINE_COLOR = 0xb98cff;
const GHOST_LINE_RADIUS = 0.05;
const GHOST_LINE_OPACITY = 0.4;
const GHOST_LINE_PREVIEW_OPACITY = 0.18;
const LINE_DRAG_SLOP_PX = 6; // less travel than this is a click, not a drag

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
    outlineThickness: 0,     // fraction of the piece radius, 0 = off
    maskOpacity: 0
};

let activeDrops = [];        // { mesh, startY, endY, start, duration }
const DROP_SPAWN_Y = 6.5;
const DROP_DURATION_MS = 450;

// Analysis best-move marker: a breathing bead on the engine's top column, coloured for
// the side to move. Its cell is recomputed from the board every frame.
const BEST_MOVE_LIGHT_COLOR = 0xffe6c2;
const BEST_MOVE_DARK_COLOR = 0x9c5a2a;
const BEST_MOVE_CYCLE_MS = 3600;
const BEST_MOVE_SWAP_MS = 240;
const BEST_MOVE_MIN_OPACITY = 0.4;
const BEST_MOVE_MAX_OPACITY = 0.65;
const BEST_MOVE_SCALE = 0.94;          // inside a real piece, so a hover preview never z-fights
let bestMoveColumn = null;
let bestMoveMesh = null;
let bestMoveCell = null;
let bestMovePresence = 0;    // 0..1 fade
let bestMoveLastFrame = 0;

// The bead mesh, baked by tools/build_piece.mjs: centred on a unit bounding sphere, so it
// fills the space of the sphere used until it loads (or if it fails to).
const PIECE_MODEL_URL = '/static/models/piece.bin';
let pieceBaseGeo = ensureUv1(new THREE.SphereGeometry(1, 32, 32));
let pieceModelLoaded = false;
// How far the bead reaches from its centre (~0.85); used for outlines and bars.
let pieceSilhouetteRadius = 1.0;

// 512px maps built from the 4k sources in textures/ by tools/build_textures.py.
const TEXTURE_DIR = '/static/textures/';
// The oak map is a whole plank, so it is tiled for the grain to read on a bead.
const CLAY_TEXTURE_REPEAT = 1;
const OAK_TEXTURE_REPEAT = 4;
let pieceTextures = null;    // { light: {...map slots}, dark: {...} }

async function loadPieceTextures() {
    const loader = new THREE.TextureLoader();
    const load = async (file, colorSpace, repeat) => {
        const texture = await loader.loadAsync(TEXTURE_DIR + file);
        texture.colorSpace = colorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(repeat, repeat);
        return texture;
    };

    const [clayAlbedo, clayNormal, clayRough, oakAlbedo, oakArm] = await Promise.all([
        load('clay_floor_001_diff_pale.jpg', THREE.SRGBColorSpace, CLAY_TEXTURE_REPEAT),
        load('clay_floor_001_nor_gl.jpg', THREE.NoColorSpace, CLAY_TEXTURE_REPEAT),
        load('clay_floor_001_rough.jpg', THREE.NoColorSpace, CLAY_TEXTURE_REPEAT),
        load('oak_veneer_01_diff.jpg', THREE.SRGBColorSpace, OAK_TEXTURE_REPEAT),
        load('oak_veneer_01_arm.jpg', THREE.NoColorSpace, OAK_TEXTURE_REPEAT),
    ]);

    pieceTextures = {
        light: { map: clayAlbedo, normalMap: clayNormal, roughnessMap: clayRough },
        // ARM packs AO, roughness and metalness into R, G, B; metalness stays unused.
        dark: { map: oakAlbedo, aoMap: oakArm, roughnessMap: oakArm },
    };
}

function applyTextureAnisotropy() {
    if (!pieceTextures || !renderer) return;
    const max = renderer.capabilities.getMaxAnisotropy();
    for (const set of Object.values(pieceTextures)) {
        for (const texture of Object.values(set)) {
            texture.anisotropy = max;
            texture.needsUpdate = true;
        }
    }
}

// MeshStandardMaterial parameters for a player's pieces; flat colour without textures.
function pieceSurface(player) {
    const maps = pieceTextures && (player === 1 ? pieceTextures.light : pieceTextures.dark);
    return {
        color: player === 1 ? player1Color : player2Color,
        roughness: maps ? 1.0 : 0.5,   // multiplied by roughnessMap
        metalness: 0,
        ...(maps || {}),
    };
}

// aoMap reads uv1; the model only has one UV set.
function ensureUv1(geometry) {
    if (geometry.attributes.uv && !geometry.attributes.uv1) {
        geometry.setAttribute('uv1', geometry.attributes.uv);
    }
    return geometry;
}

let moveHistory = [];
let currentMoveIndex = 0;

// The board belongs to a server-side room shared by every viewer (see sync.js).
let sync = null;
let applyingRemote = false;  // suppresses pushes while applying a remote state
let engineLock = null;       // another viewer's running search, or null
let viewers = [];

let isPuzzleMode = false;
let puzzles = [];
let currentPuzzleIndex = 0;
let currentPuzzleSolutionIndex = 0;
let puzzleSource = null;     // 'file' | 'engine'
let selectedCategory = 'quick';
// Mirrors puzzle_bank.CATEGORIES; refreshed from puzzles.json.
let CATEGORIES = [
    { key: 'quick',   label: 'Quick puzzle',  range_label: '1–3 moves to mate',  min: 1,  max: 3 },
    { key: 'medium',  label: 'Medium puzzle', range_label: '4–5 moves to mate',  min: 4,  max: 5 },
    { key: 'long',    label: 'Long puzzle',   range_label: '6–11 moves to mate', min: 6,  max: 11 },
    { key: 'endgame', label: 'Endgame',       range_label: '12+ moves to mate',  min: 12, max: null },
];
const categoryLabel = (key) => (CATEGORIES.find(c => c.key === key) || {}).label || key;
let currentPuzzleSolved = false;
let lastCategoryCounts = {};

async function loadPieceModel(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const buffer = await res.arrayBuffer();
    const [vertexCount, indexCount] = new Uint32Array(buffer, 0, 2);
    let offset = 12;
    const take = (Type, length) => {
        const view = new Type(buffer, offset, length);
        offset += view.byteLength;
        return view;
    };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(take(Float32Array, vertexCount * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(take(Float32Array, vertexCount * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(take(Float32Array, vertexCount * 2), 2));
    geo.setIndex(new THREE.BufferAttribute(take(Uint16Array, indexCount), 1));
    geo.computeBoundingSphere();

    pieceSilhouetteRadius = new Float32Array(buffer, 8, 1)[0];
    pieceBaseGeo.dispose();
    pieceBaseGeo = ensureUv1(geo);
    pieceModelLoaded = true;
}

// All pieces share pieceBaseGeo.
function createPieceMesh(material) {
    const mesh = new THREE.Mesh(pieceBaseGeo, material);
    mesh.scale.setScalar(0.4 * gameSettings.pieceSize);
    return mesh;
}

// --- INITIALIZATION ---

function init() {
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

    const PUZZLE_FILE_INPUT = document.getElementById('puzzle-file-input');
    const UPLOAD_PUZZLE_BTN = document.getElementById('upload-puzzle-btn');
    const PREV_PUZZLE_BTN = document.getElementById('prev-puzzle-btn');
    const NEXT_PUZZLE_BTN = document.getElementById('next-puzzle-btn');
    const RESET_PUZZLE_BTN = document.getElementById('reset-puzzle-btn');
    const EXIT_PUZZLE_BTN = document.getElementById('exit-puzzle-btn');
    const SHOW_SOLUTION_BTN = document.getElementById('show-solution-btn');

    const ENGINE_PUZZLE_BTN = document.getElementById('engine-puzzle-btn');
    const CANCEL_ENGINE_SETUP_BTN = document.getElementById('cancel-engine-setup-btn');
    const START_PUZZLE_BTN = document.getElementById('start-puzzle-btn');
    const CATEGORY_SELECTOR = document.getElementById('category-selector');

    UPLOAD_PUZZLE_BTN.addEventListener('click', () => PUZZLE_FILE_INPUT.click());
    PUZZLE_FILE_INPUT.addEventListener('change', handlePuzzleFileUpload);
    PREV_PUZZLE_BTN.addEventListener('click', handlePrevPuzzle);
    NEXT_PUZZLE_BTN.addEventListener('click', handleNextPuzzle);
    RESET_PUZZLE_BTN.addEventListener('click', () => loadPuzzle(currentPuzzleIndex));
    EXIT_PUZZLE_BTN.addEventListener('click', exitPuzzleMode);
    SHOW_SOLUTION_BTN.addEventListener('click', showSolution);

    ENGINE_PUZZLE_BTN.addEventListener('click', openEnginePuzzleSetup);
    CANCEL_ENGINE_SETUP_BTN.addEventListener('click', closeEnginePuzzleSetup);
    START_PUZZLE_BTN.addEventListener('click', () => startEnginePuzzle(selectedCategory));
    CATEGORY_SELECTOR.querySelectorAll('.cat-btn').forEach(btn => {
        btn.addEventListener('click', () => selectCategory(btn.dataset.category));
    });

    game = new ConnectFour3D();
    boardState = game.getInitialState();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(4, 4, 6);

    const container = document.getElementById('scene-container');
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);
    applyTextureAnisotropy();

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(1.5, 1.5, 1.5);
    controls.enableDamping = true;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(5, 10, 7.5);
    scene.add(directionalLight);

    ghostPlayer1Material = new THREE.MeshStandardMaterial({
        color: player1GhostColor,
        roughness: 0.5
    });
    ghostPlayer2Material = new THREE.MeshStandardMaterial({
        color: player2GhostColor,
        roughness: 0.5
    });

    drawBoardGrid();
    drawColumnPoles();
    drawCornerLabels();
    createClickTargets();

    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('mousedown', onColumnClick);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    // Right-click plans ghosts and traces ghost lines.
    renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    // Capture phase, so a ghost-line drag can disable panning before OrbitControls sees the press.
    renderer.domElement.addEventListener('pointerdown', onLineDragStart, true);
    window.addEventListener('pointerup', onLineDragEnd);
    window.addEventListener('pointercancel', cancelLineDrag);
    window.addEventListener('blur', cancelLineDrag);
    NEW_GAME_BTN.addEventListener('click', startNewGame);
    AI_MOVE_BTN.addEventListener('click', requestAIMove);
    MINIMAX_MOVE_BTN.addEventListener('click', requestMinimaxMove);
    UNDO_BTN.addEventListener('click', undoLastMove);
    COPY_HEX_BTN.addEventListener('click', copyHexCode);
    COPY_MOVES_BTN.addEventListener('click', copyMoveHistory);

    SETTINGS_BTN.addEventListener('click', () => SETTINGS_MODAL_OVERLAY.classList.remove('hidden'));
    CLOSE_SETTINGS_BTN.addEventListener('click', () => SETTINGS_MODAL_OVERLAY.classList.add('hidden'));
    SETTINGS_MODAL_OVERLAY.addEventListener('click', (event) => {
        if (event.target === SETTINGS_MODAL_OVERLAY) SETTINGS_MODAL_OVERLAY.classList.add('hidden');
    });

    for (const [slider, label, key, digits] of [
        [PIECE_SIZE_SLIDER, PIECE_SIZE_VALUE, 'pieceSize', 1],
        [PIECE_OPACITY_SLIDER, PIECE_OPACITY_VALUE, 'pieceOpacity', 1],
        [OUTLINE_THICKNESS_SLIDER, OUTLINE_THICKNESS_VALUE, 'outlineThickness', 2],
        [MASK_OPACITY_SLIDER, MASK_OPACITY_VALUE, 'maskOpacity', 2],
    ]) {
        slider.addEventListener('input', (event) => {
            gameSettings[key] = parseFloat(event.target.value);
            label.textContent = gameSettings[key].toFixed(digits);
            updateBoard(boardState);
        });
    }

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

    COLUMN_NUMBERING_TOGGLE.addEventListener('change', (event) => {
        setOneIndexed(event.target.checked);
    });

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

    initSync();

    animate();
}

function refreshColumnNumberingHints() {
    const example = formatColumns([1, 3, 12, 15]);
    MOVE_INPUT.placeholder = `e.g., ${example} or ${example.replace(/ /g, ',')}`;
    COLUMN_NUMBERING_NOTE.textContent = 'Display only — the board labels, move history, log '
        + `and analysis panel number the columns ${columnRange()}.`;
}

async function copyToClipboard(button, text, logText) {
    try {
        await navigator.clipboard.writeText(text);
        logMessage(logText);
        button.dataset.icon ??= button.textContent;
        button.textContent = '✅';
        setTimeout(() => { button.textContent = button.dataset.icon; }, 1500);
    } catch (err) {
        console.error('Clipboard write failed:', err);
        logMessage('Error: Could not copy to the clipboard.');
    }
}

function copyMoveHistory() {
    const moves = moveHistory.slice(0, currentMoveIndex);
    copyToClipboard(COPY_MOVES_BTN, formatColumns(moves),
        `Copied moves to clipboard: ${moves.map(columnTag).join(' ')}`);
}

function copyHexCode() {
    const hexCode = game.getStateHexCode(boardState);
    copyToClipboard(COPY_HEX_BTN, hexCode, `Copied hex to clipboard: ${hexCode}`);
}

// --- 3D BOARD DRAWING ---

// Modelled on the real game: a base plate with one pole per column; pieces are beads on the poles.
const BASE_PLANE_Y = -0.5;
const POLE_TOP_Y = 3.3;      // just above the top bead
const POLE_RADIUS = 0.04;

function drawBoardGrid() {
    // depthWrite: false so only pieces trigger occlusion outlines.
    const material = new THREE.LineBasicMaterial({ color: 0x555555, depthWrite: false });
    const points = [];
    const size = 4;
    const offset = -0.5;

    for (let i = 0; i <= size; i++) {
        points.push(new THREE.Vector3(offset, BASE_PLANE_Y, offset + i));
        points.push(new THREE.Vector3(offset + size, BASE_PLANE_Y, offset + i));
        points.push(new THREE.Vector3(offset + i, BASE_PLANE_Y, offset));
        points.push(new THREE.Vector3(offset + i, BASE_PLANE_Y, offset + size));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.LineSegments(geometry, material);
    scene.add(line);
}

// Cell (col, row) is centred at x = col, z = row.
function drawColumnPoles() {
    const height = POLE_TOP_Y - BASE_PLANE_Y;
    const geometry = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, height, 16);
    // In the transparent list at renderOrder 1000 so the poles draw after the outline rings;
    // otherwise a pole in front of a piece would light up its outline.
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
    // No depth writes, so labels never trigger outlines; drawn above the poles.
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.9, 0.9, 0.9);
    sprite.renderOrder = 2000;
    return sprite;
}

// Labels for the corner columns 0, 3, 12 and 15, just outside their corners.
let cornerLabels = [];

function drawCornerLabels() {
    const out = 1.2;
    const labels = [
        { n: 0,  x: -out,     z: -out },
        { n: 3,  x: 3 + out,  z: -out },
        { n: 12, x: -out,     z: 3 + out },
        { n: 15, x: 3 + out,  z: 3 + out },
    ];
    for (const l of labels) {
        const sprite = makeTextSprite(formatColumn(l.n));
        sprite.position.set(l.x, 0, l.z);
        scene.add(sprite);
        cornerLabels.push(sprite);
    }
}

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
            plane.position.set(col, 4, row);
            plane.rotation.x = -Math.PI / 2;
            plane.userData.column = row * 4 + col;
            scene.add(plane);
            clickTargets.push(plane);
        }
    }
}

let outlineGeo = null;   // shared by the current outline rings

function clearPieces() {
    for (const piece of pieces) {
        scene.remove(piece);
        piece.material.dispose();
    }
    pieces = [];
    for (const { mask, ring } of pieceOverlays) {
        mask?.material.dispose();
        if (ring) {
            scene.remove(ring);
            ring.material.dispose();
        }
    }
    pieceOverlays = [];
    outlineGeo?.dispose();
    outlineGeo = null;
}

// dropCoords [depth, row, col] is the just-played cell, animated falling in.
function updateBoard(boardState, dropCoords = null) {
    analysis?.setPosition(moveHistory.slice(0, currentMoveIndex));
    activeDrops = [];

    // Carry each cell's fade (keyed z * 16 + y * 4 + x) over to its rebuilt overlay.
    const previousFade = new Map(pieceOverlays.map(o => [o.key, o.fade]));
    clearPieces();

    clearGhostPieces();
    clearGhostLines();
    clearPreview();

    const pieceScale = 0.4 * gameSettings.pieceSize;
    const silhouetteRadius = pieceSilhouetteRadius * pieceScale;

    const isTransparent = gameSettings.pieceOpacity < 1.0;

    // Outline ring: outer edge at the silhouette, extending inward by the chosen thickness.
    const outlineThickness = gameSettings.outlineThickness;
    const showOutlines = outlineThickness > 0;
    outlineGeo = showOutlines
        ? new THREE.RingGeometry(Math.max(0, silhouetteRadius * (1 - outlineThickness)), silhouetteRadius, 48)
        : null;
    const showMasks = gameSettings.maskOpacity > 0;

    // Each piece stamps a unique stencil id where it is front-most, so its overlays only draw
    // where a different piece hides it.
    let stencilId = 0;

    for (let z = 0; z < 4; z++) {
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const pieceValue = boardState[z][y][x];
                if (pieceValue !== 0) {
                    stencilId++;

                    const material = new THREE.MeshStandardMaterial({
                        ...pieceSurface(pieceValue),
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
                    piece.userData.cell = [z, y, x];
                    scene.add(piece);
                    pieces.push(piece);

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

                    // Drawn before the mask, which rewrites the stencil buffer.
                    let outlineRing = null;
                    if (showOutlines) {
                        const outlineMat = new THREE.MeshBasicMaterial({
                            color: overlayColor,
                            side: THREE.DoubleSide,
                            transparent: true,
                            opacity: 0,
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

                    // Occlusion mask: the piece's own geometry drawn with GreaterDepth, i.e.
                    // exactly where another piece hides it.
                    let mask = null;
                    if (showMasks) {
                        const maskMat = new THREE.MeshBasicMaterial({
                            color: overlayColor,
                            transparent: true,
                            opacity: 0,
                            depthTest: true,
                            depthFunc: THREE.GreaterDepth,
                            depthWrite: false,
                            stencilWrite: true,
                            stencilRef: stencilId,
                            stencilFunc: THREE.NotEqualStencilFunc,
                            stencilFail: THREE.KeepStencilOp,
                            stencilZFail: THREE.KeepStencilOp,
                            // The bore lets one ray cross the bead twice; stamping our own id
                            // blends each pixel once.
                            stencilZPass: THREE.ReplaceStencilOp
                        });
                        mask = new THREE.Mesh(pieceBaseGeo, maskMat);
                        mask.renderOrder = 998;
                        mask.visible = false;
                        piece.add(mask);
                    }

                    if (mask || outlineRing) {
                        const key = z * 16 + y * 4 + x;
                        const overlay = { piece, mask, ring: outlineRing, key, fade: previousFade.get(key) || 0 };
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

const WIN_LINE_COLOR = 0x4fd1ff;
const WIN_LINE_RADIUS = 0.075;
const WIN_LINE_OPACITY = 0.9;

const _winAxis = new THREE.Vector3();
const _winUp = new THREE.Vector3(0, 1, 0);

function clearWinHighlight() {
    disposeMeshes(winHighlights);
    winHighlights = [];
}

// A bar through every four-in-a-row; `reach` extends it to the outer edge of the end beads.
function updateWinHighlight(state, reach) {
    clearWinHighlight();
    if (!game) return;

    const lines = game.getWinningLines(state);
    if (lines.length === 0) return;

    for (const { cells } of lines) {
        const bar = makeCellSpanBar(cells[0], cells[cells.length - 1], {
            color: WIN_LINE_COLOR,
            radius: WIN_LINE_RADIUS,
            opacity: WIN_LINE_OPACITY,
            reach,
            // Above the poles (1000) but below the corner labels (2000).
            renderOrder: 1500,
        });
        // Shown once the winning piece lands (see updateDrops).
        bar.visible = activeDrops.length === 0;
        scene.add(bar);
        winHighlights.push(bar);
    }
}

// A bar along the run between two cells, extended by `reach` past each end.
function makeCellSpanBar(fromCell, toCell, { color, radius, opacity, reach, renderOrder }) {
    const from = cellToWorld(fromCell);
    const to = cellToWorld(toCell);

    _winAxis.copy(to).sub(from);
    const span = _winAxis.length();
    _winAxis.normalize();

    // Capsule length is body + 2 * radius.
    const body = Math.max(0.001, span + 2 * reach - 2 * radius);
    const bar = new THREE.Mesh(
        new THREE.CapsuleGeometry(radius, body, 6, 16),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity,
            // Drawn on top, since the bar runs through the beads.
            depthTest: false,
            depthWrite: false
        }));
    bar.position.copy(from).add(to).multiplyScalar(0.5);
    bar.quaternion.setFromUnitVectors(_winUp, _winAxis);
    bar.renderOrder = renderOrder;
    return bar;
}

// --- GHOST LINES ---

function pieceReach() {
    return pieceSilhouetteRadius * 0.4 * gameSettings.pieceSize;
}

function disposeMeshes(meshes) {
    meshes.forEach(m => {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
    });
}

function clearGhostLines() {
    disposeMeshes(ghostLineMeshes);
    ghostLineMeshes = [];
    ghostLineCells = [];
}

function renderGhostLines(lines) {
    // Copied first: `lines` may be ghostLineCells itself.
    const wanted = lines.map(l => ({ a: l.a, b: l.b }));
    clearGhostLines();
    const reach = pieceReach();
    for (const { a, b } of wanted) {
        const bar = makeCellSpanBar(a, b, {
            color: GHOST_LINE_COLOR,
            radius: GHOST_LINE_RADIUS,
            opacity: GHOST_LINE_OPACITY,
            reach,
            // Below the win bars (1500).
            renderOrder: 1400,
        });
        scene.add(bar);
        ghostLineMeshes.push(bar);
    }
    ghostLineCells = wanted;
}

// Tracing a line that is already shown removes it.
function addGhostLine(fromCell, toCell) {
    const line = game.findLineThrough(fromCell, toCell);
    if (!line) {
        logMessage('Those two pieces are not on the same line.');
        return;
    }
    const ends = { a: line[0], b: line[line.length - 1] };
    const existing = ghostLineCells.findIndex(l => sameCell(l.a, ends.a) && sameCell(l.b, ends.b));
    const next = ghostLineCells.slice();
    if (existing >= 0) next.splice(existing, 1);
    else next.push(ends);

    renderGhostLines(next);
    pushShared({ lines: lineCells() });
}

function lineCells() {
    return ghostLineCells.map(l => ({ a: l.a, b: l.b }));
}

function cellToWorld([z, y, x]) {
    return new THREE.Vector3(x, 3 - z, y);
}

function updateMoveHistory(newMoveHistory) {
    moveHistory = newMoveHistory;
    MOVE_HISTORY_BOX.innerHTML = '';
    moveHistory.forEach((move, index) => {
        const moveBox = document.createElement('div');
        moveBox.classList.add('move-box');
        moveBox.classList.add(index % 2 === 0 ? 'move-player1' : 'move-player2');
        if (index === currentMoveIndex - 1) moveBox.classList.add('current-move');
        moveBox.textContent = formatColumn(move);
        MOVE_HISTORY_BOX.appendChild(moveBox);
    });
    MOVE_HISTORY_BOX.scrollTop = MOVE_HISTORY_BOX.scrollHeight;
    updatePieceCount();
}

function updatePieceCount() {
    PIECE_COUNT_VALUE.textContent = currentMoveIndex;
}

// --- SHARED SESSION ---

function initSync() {
    sync = new RoomSync({
        onState: applyRemoteState,
        onPresence: renderPresence,
        onLog: renderRemoteLog,
        onConnection: renderConnection,
        onMeta: renderRoomMeta,
        onRejected: (error) => logMessage(error),
        onMissing: showRoomMissing,
    });
    document.querySelectorAll('.seat').forEach(btn => {
        btn.addEventListener('click', () => toggleSeat(Number(btn.dataset.seat)));
    });
    document.getElementById('copy-link-btn').addEventListener('click', copyRoomLink);
    if (!sync.room) {
        showRoomMissing();
        return;
    }
    sync.start();
}

function renderRoomMeta(meta) {
    const label = document.getElementById('room-name');
    label.textContent = `${meta.name} · ${meta.code}`;
    label.title = `${meta.visibility === 'private' ? 'Private' : 'Public'} room ${meta.code}`;
    document.title = `${meta.name} · 3D Connect Four`;
}

function showRoomMissing() {
    if (document.getElementById('room-missing')) return;
    const box = document.createElement('div');
    box.id = 'room-missing';
    const text = document.createElement('p');
    text.textContent = 'This room does not exist.';
    const link = document.createElement('a');
    link.href = '/';
    link.textContent = 'Back to the menu';
    box.append(text, link);
    document.body.appendChild(box);
}

async function copyRoomLink() {
    const btn = document.getElementById('copy-link-btn');
    try {
        await navigator.clipboard.writeText(location.origin + location.pathname);
        btn.textContent = 'Copied';
    } catch (e) {
        btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
}

async function toggleSeat(player) {
    const result = await sync.takeSeat(sync.mySeat() === player ? null : player);
    if (!result.ok && result.error) logMessage(result.error);
}

function renderSeats(seats) {
    document.querySelectorAll('.seat').forEach(btn => {
        const holderId = seats[btn.dataset.seat];
        const holder = viewers.find(v => v.id === holderId);
        const mine = holderId === sync.clientId;
        const label = btn.querySelector('.seat-holder');
        label.classList.toggle('away', !!holderId && !holder);
        if (mine) label.textContent = 'You · stand up';
        else if (holder) label.textContent = holder.name;
        else if (holderId) label.textContent = 'Away · take seat';
        else label.textContent = 'Open · sit here';
        btn.classList.toggle('mine', mine);
        btn.disabled = !!holder && !mine;
    });
}

// Why this viewer cannot play `player` right now, or null.
function seatBlock(player) {
    if (!sync || sync.canPlay(player)) return null;
    if (sync.mySeat() === null) return 'You are watching. Take an open seat to play.';
    return "It's your opponent's move.";
}

function fullSharedState() {
    return {
        mode: isPuzzleMode ? 'puzzle' : 'game',
        moves: moveHistory,
        view_index: currentMoveIndex,
        ghosts: ghostCells(),
        lines: lineCells(),
        puzzle: isPuzzleMode ? sharedPuzzleState() : null,
        progress: isPuzzleMode ? sharedProgress() : null,
    };
}

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

// `expect` makes the push conditional on the room's version, so two viewers adding a move at
// once cannot both succeed.
async function pushShared(patch, { expect = false, log = null } = {}) {
    if (!sync || applyingRemote) return { ok: true };
    const result = await sync.push(patch, { expect, log });
    if (result.conflict) {
        // sync already applied the state we missed.
        logMessage('Another viewer moved first — the board has been resynced.');
    }
    if (result.error === 'offline' || result.error === 'disconnected') {
        logMessage('Not connected to the room, so that change was not shared.');
    }
    return result;
}

function pushBoard({ log = null, expect = true } = {}) {
    const { puzzle, ...board } = fullSharedState();
    return pushShared(board, { expect, log });
}

function setEngineBusy(what) {
    return pushShared({ busy: what ? { what } : null });
}

function engineBusyElsewhere() {
    return engineLock !== null;
}

// Apply a board from another viewer; `applyingRemote` stops it echoing back.
function applyRemoteState(state) {
    if (!state || !game) return;
    applyingRemote = true;
    try {
        updateEngineLock(state.busy);

        const moves = Array.isArray(state.moves) ? state.moves : [];
        const viewIndex = Math.max(0, Math.min(state.view_index ?? moves.length, moves.length));

        // Most polls describe the board already on screen; skipping them avoids restarting
        // animations.
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

        updateBoard(boardState, dropCoords);       // clears ghosts and lines...
        renderGhosts(state.ghosts || []);          // ...so redraw the shared ones
        renderGhostLines(state.lines || []);
        updateMoveHistory(moveHistory);
        refreshControls();
    } finally {
        applyingRemote = false;
    }
}

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

    const myLines = ghostLineCells;
    const theirLines = state.lines || [];
    if (theirLines.length !== myLines.length) return false;
    if (!theirLines.every((l, i) => sameCell(l.a, myLines[i].a) && sameCell(l.b, myLines[i].b))) {
        return false;
    }

    if (isPuzzleMode) {
        const p = state.progress || {};
        if ((p.index || 0) !== currentPuzzleIndex) return false;
        if ((p.solution_index || 0) !== currentPuzzleSolutionIndex) return false;
        if (!!p.solved !== currentPuzzleSolved) return false;
        // Two puzzles can share a history, so compare solutions too.
        const here = puzzles[currentPuzzleIndex];
        const there = (state.puzzle && state.puzzle.puzzles || [])[currentPuzzleIndex];
        if (JSON.stringify(here && here.solution) !== JSON.stringify(there && there.solution)) {
            return false;
        }
    }
    return true;
}

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

// One new move from someone else gets the drop animation.
function remoteDropCoords(moves, viewIndex) {
    if (viewIndex !== moves.length) return null;
    if (moves.length !== moveHistory.length + 1) return null;
    if (currentMoveIndex !== moveHistory.length) return null;
    if (!moveHistory.every((m, i) => m === moves[i])) return null;

    const before = game.getStateFromMoves(moves.slice(0, -1)).state;
    return game.getLandingPosition(before, moves[moves.length - 1]);
}

// Ghosts travel as world coordinates.
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
        const piece = createGhostMesh(
            c.player, [3 - Math.round(c.y), Math.round(c.z), Math.round(c.x)]);
        scene.add(piece);
        ghostPieces.push(piece);
    });
}

function createGhostMesh(player, [depth, row, col]) {
    const mesh = createPieceMesh(player === 1 ? ghostPlayer1Material : ghostPlayer2Material);
    mesh.position.set(col, 3 - depth, row);
    mesh.userData.cell = [depth, row, col];
    return mesh;
}

// Button state for the current board, without logging the result (used for remote boards).
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

function renderPresence(clients, seats) {
    viewers = clients;
    renderSeats(seats);
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
    label.textContent = n === 1 ? '1 viewer' : `${n} viewers`;
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
        // Columns arrive as tags and render in this viewer's numbering.
        const said = document.createElement('span');
        setColumnText(said, e.text);
        line.append(who, said);
        LOG_BOX.appendChild(line);
        LOG_BOX.scrollTop = LOG_BOX.scrollHeight;
    });
}


// --- GAME FLOW ---

// Columns in `message` are tags (see columnLabels.js), re-rendered if the numbering changes.
function logMessage(message) {
    setColumnText(STATUS_MSG, message);

    const logEntry = document.createElement('p');
    setColumnText(logEntry, `> ${message}`);
    LOG_BOX.appendChild(logEntry);

    LOG_BOX.scrollTop = LOG_BOX.scrollHeight;
}

function setButtonsDisabled(state) {
    NEW_GAME_BTN.disabled = state;
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
        return false;
    }

    if (value === 0) {
        logMessage("It's a draw!");
    } else if (terminalMessage) {
        logMessage(terminalMessage);
    } else {
        logMessage((game.getCurrentPlayer(boardState) === 1 ? 'Player 2' : 'Player 1') + ' wins!');
    }
    setButtonsDisabled(true);
    NEW_GAME_BTN.disabled = false;
    UNDO_BTN.disabled = true;
    return true;
}

async function startNewGame() {
    logMessage('Starting new game...');
    setButtonsDisabled(true);
    isRequestInProgress = true;

    try {
        boardState = game.getInitialState();
        moveHistory = [];
        currentMoveIndex = 0;
        updateBoard(boardState);
        updateMoveHistory(moveHistory);
        logMessage('Your turn! Click a column or let the AI play.');
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

// Plays `move` at the end of the history, with the drop animation.
function playMove(move) {
    const dropCoords = game.getLandingPosition(boardState, move);
    boardState = game.getNextState(boardState, move);
    moveHistory.push(move);
    currentMoveIndex = moveHistory.length;
    updateBoard(boardState, dropCoords);
    updateMoveHistory(moveHistory);
}

async function handlePlayerMove(column) {
    if (isRequestInProgress) return;

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

    const blocked = !analysis?.enabled && seatBlock(game.getCurrentPlayer(boardState));
    if (blocked) {
        logMessage(blocked);
        return;
    }

    setButtonsDisabled(true);
    logMessage('Processing your move...');

    if (analysis?.enabled) moveHistory = moveHistory.slice(0, currentMoveIndex);
    playMove(column);

    // Rejected if another viewer moved first, in which case the board shown is theirs.
    isRequestInProgress = true;
    const pushed = await pushBoard({ log: `played column ${columnTag(column)}.` });
    isRequestInProgress = false;
    if (!pushed.ok) return;

    if (!checkGameOver('You win!', 'Your turn! Click a column or let the AI play.')) {
        const autoReply = !analysis?.enabled && !seatBlock(game.getCurrentPlayer(boardState));
        if (gameSettings.autoAIMove && autoReply) {
            setTimeout(() => requestAIMove(), 100);
        } else if (gameSettings.autoMinimaxMove && autoReply) {
            setTimeout(() => requestMinimaxMove(), 100);
        }
    }
}

// Plays an analysis line in one push; stops at the first unplayable move or at game over.
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

    // No drop animation for several moves at once.
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

const OPPONENTS = {
    ai: {
        name: 'an AI',
        thinking: 'AI is thinking... 🤔',
        played: 'the AI',
        wins: 'AI wins!',
        move: () => aiMove(moveHistory, {
            onStatus: status => {
                if (status === 'loading') logMessage('Loading the AI into this browser...');
                else logMessage(`AI loaded (${status === 'webgpu' ? 'WebGPU' : 'WebAssembly'}).`);
            },
            onProgress: (done, total) => setColumnText(STATUS_MSG, `AI is thinking... ${done}/${total} 🤔`),
        }),
    },
    minimax: {
        name: 'a minimax',
        thinking: 'Minimax AI is thinking...',
        played: 'the minimax engine',
        wins: 'Minimax AI wins!',
        move: () => bestMove(moveHistory),
    },
};

const requestAIMove = () => requestEngineMove('ai');
const requestMinimaxMove = () => requestEngineMove('minimax');

// Both opponents search in this browser (nnAgent.js, engine.js).
async function requestEngineMove(kind) {
    if (isRequestInProgress || analysis?.enabled) return;
    const opponent = OPPONENTS[kind];

    clearPreview();

    if (currentMoveIndex !== moveHistory.length) {
        logMessage('You must be at the most recent move to play.');
        return;
    }

    const [, isTerminal] = game.getValueAndTerminated(boardState);
    if (isTerminal) {
        logMessage(`Game is over. Cannot make ${opponent.name} move.`);
        return;
    }

    if (engineBusyElsewhere()) {
        logMessage('Another viewer already has the engine running.');
        return;
    }

    const blocked = seatBlock(game.getCurrentPlayer(boardState));
    if (blocked) {
        logMessage(blocked);
        return;
    }

    isRequestInProgress = true;
    setButtonsDisabled(true);
    logMessage(opponent.thinking);
    await setEngineBusy(kind);

    try {
        const { move } = await opponent.move();
        playMove(move);

        const pushed = await pushBoard({ log: `let ${opponent.played} play column ${columnTag(move)}.` });
        if (!pushed.ok) return;

        if (!checkGameOver(opponent.wins, 'Your turn! Click a column or let the AI play.')) {
            setButtonsDisabled(false);
        }
    } catch (error) {
        console.error(`Error during ${kind} move:`, error);
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
        clearGhostLines();
        return;
    }

    currentMoveIndex = newIndex;
    const isViewingLive = currentMoveIndex === moveHistory.length;
    boardState = game.getStateFromMoves(moveHistory.slice(0, currentMoveIndex)).state;
    updateBoard(boardState);
    updateMoveHistory(moveHistory);

    pushShared({ view_index: currentMoveIndex, ghosts: [], lines: [] });

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
    if (event.key !== 'Enter') return;
    const movesString = MOVE_INPUT.value.trim();
    if (!movesString) return;

    // Read in the numbering on screen, so a copied move list pastes back.
    const tokens = movesString.split(/[\s,]+/).filter(t => t.length);
    const moves = tokens.map(parseColumn);
    if (moves.some(move => move === null)) {
        logMessage(`Invalid move list: expected columns ${columnRange()}, separated by spaces or commas.`);
        return;
    }

    MOVE_INPUT.value = '';
    logMessage(`Loading position from moves: ${moves.map(columnTag).join(' ')}`);
    setButtonsDisabled(true);
    isRequestInProgress = true;

    const { state, appliedMoves } = game.getStateFromMoves(moves);
    if (appliedMoves.length < moves.length) {
        logMessage('Warning: Invalid move found. Displaying state before invalid move.');
    }

    boardState = state;
    moveHistory = appliedMoves;
    currentMoveIndex = appliedMoves.length;

    updateBoard(boardState);
    updateMoveHistory(moveHistory);

    // Unconditional: loading a position puts everyone on it.
    pushBoard({ expect: false, log: `loaded a position: ${appliedMoves.map(columnTag).join(' ') || '(empty board)'}` });

    setButtonsDisabled(false);
    isRequestInProgress = false;
}

function handleKeyDown(event) {
    if (document.activeElement?.matches('input, select, textarea, [contenteditable="true"]')) {
        return;
    }
    if (isRequestInProgress || isPuzzleMode) return;

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

// --- POINTER PICKING ---

const _pickRay = new THREE.Raycaster();
const _pickPoint = new THREE.Vector2();

function pointerNdc(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    _pickPoint.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1);
    return _pickPoint;
}

// The column a click would play, via the invisible planes above the board.
function pickColumn(event) {
    _pickRay.setFromCamera(pointerNdc(event), camera);
    const hits = _pickRay.intersectObjects(clickTargets);
    return hits.length ? hits[0].object.userData.column : null;
}

// Cell of the bead (or ghost) under the pointer.
function pickPieceCell(event) {
    _pickRay.setFromCamera(pointerNdc(event), camera);
    // Non-recursive: masks are child meshes with no cell.
    const hits = _pickRay.intersectObjects(pieces.concat(ghostPieces), false);
    return hits.length ? (hits[0].object.userData.cell || null) : null;
}

function onColumnClick(event) {
    if (isRequestInProgress) return;

    clearPreview();

    if (event.button === 0) {
        const column = pickColumn(event);
        if (column !== null) handlePlayerMove(column);
    } else if (event.button === 2 && !lineDrag) {
        // A right-press on a bead is settled in onLineDragEnd.
        rightClickAt(event);
    }
}

// Right-click on a column plans a ghost; elsewhere it clears ghosts and lines.
function rightClickAt(event) {
    const column = pickColumn(event);
    if (column !== null) {
        handleGhostMove(column);
    } else {
        clearGhostPieces();
        clearGhostLines();
        pushShared({ ghosts: [], lines: [] });
    }
}

// --- GHOST LINE DRAG ---

// Capture phase, before OrbitControls' pointerdown. Right-drag pans, so panning is off while tracing.
function onLineDragStart(event) {
    if (event.button !== 2 || isRequestInProgress) return;
    const cell = pickPieceCell(event);
    if (!cell) return;

    lineDrag = { cell, x: event.clientX, y: event.clientY };
    controls.enablePan = false;
}

// Also used when a press never gets its release (pointercancel, blur).
function cancelLineDrag() {
    if (!lineDrag) return null;
    const start = lineDrag;
    lineDrag = null;
    controls.enablePan = true;
    clearLineDragPreview();
    return start;
}

function onLineDragEnd(event) {
    if (event.button !== 2 || !lineDrag) return;
    const start = cancelLineDrag();

    // A press that barely moved is a click even over a bead: the ray to a pole often clips one.
    const travelled = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (travelled <= LINE_DRAG_SLOP_PX) {
        if (!isRequestInProgress) rightClickAt(event);
        return;
    }

    const cell = pickPieceCell(event);
    if (cell && !sameCell(cell, start.cell)) addGhostLine(start.cell, cell);
}

function clearLineDragPreview() {
    if (!lineDragPreview) return;
    disposeMeshes([lineDragPreview.mesh]);
    lineDragPreview = null;
}

// Rebuilt only when the traced line changes.
function updateLineDragPreview(event) {
    const cell = pickPieceCell(event);
    const line = (cell && !sameCell(cell, lineDrag.cell))
        ? game.findLineThrough(lineDrag.cell, cell)
        : null;
    const key = line ? `${line[0]}-${line[line.length - 1]}` : null;
    if (lineDragPreview && lineDragPreview.key === key) return;

    clearLineDragPreview();
    if (!line) return;

    const mesh = makeCellSpanBar(line[0], line[line.length - 1], {
        color: GHOST_LINE_COLOR,
        radius: GHOST_LINE_RADIUS,
        opacity: GHOST_LINE_PREVIEW_OPACITY,
        reach: pieceReach(),
        renderOrder: 1400,
    });
    scene.add(mesh);
    lineDragPreview = { key, mesh };
}

function handleGhostMove(column) {
    const tempState = getTemporaryState();
    const landingPosition = game.getLandingPosition(tempState, column);

    if (!landingPosition) {
        logMessage('Invalid ghost move: Column is full.');
        return;
    }

    const piece = createGhostMesh(game.getCurrentPlayer(tempState), landingPosition);
    scene.add(piece);
    ghostPieces.push(piece);

    pushShared({ ghosts: ghostCells() });
}

// The board with the planning ghosts placed on it.
function getTemporaryState() {
    const tempState = structuredClone(boardState);
    for (const p of ghostPieces) {
        const [z, y, x] = p.userData.cell;
        tempState[z][y][x] = p.material === ghostPlayer1Material ? 1 : -1;
    }
    return tempState;
}

function onMouseMove(event) {
    if (isRequestInProgress) return;

    if (lineDrag) {
        clearPreview();
        updateLineDragPreview(event);
        return;
    }

    const hoveredColumn = pickColumn(event);
    if (hoveredColumn !== null) {
        showPreview(hoveredColumn);
    } else {
        clearPreview();
    }
}

function clearPreview() {
    if (!previewPiece) return;
    scene.remove(previewPiece);
    previewPiece.material.dispose();
    previewPiece = null;
    previewKey = null;
}

// Rebuilt only when the landing cell or the side to move changes, not on every mousemove.
function showPreview(column) {
    const landingPosition = game.getLandingPosition(boardState, column);
    if (!landingPosition) {
        clearPreview();
        return;
    }

    const player = game.getCurrentPlayer(boardState);
    const key = `${landingPosition}|${player}`;
    if (key === previewKey) return;
    clearPreview();

    const [depth, row, col] = landingPosition;
    previewPiece = createPieceMesh(new THREE.MeshStandardMaterial({
        ...pieceSurface(player),
        opacity: Math.min(gameSettings.pieceOpacity, 0.5),
        transparent: true,
    }));
    previewPiece.position.set(col, 3 - depth, row);
    scene.add(previewPiece);
    previewKey = key;
}

// --- BEST-MOVE INDICATOR ---

function setBestMove(column) {
    bestMoveColumn = Number.isInteger(column) ? column : null;
}

// Null when the column is not playable on the board shown.
function bestMoveTarget() {
    if (bestMoveColumn === null || !analysis?.enabled || isPuzzleMode) return null;
    return game.getLandingPosition(boardState, bestMoveColumn);
}

const sameCell = (a, b) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

// Side to move on the board shown; counted by hand since it runs every frame.
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
    // Clamped so a backgrounded tab does not snap the fade.
    const dt = Math.min(now - (bestMoveLastFrame || now), 100);
    bestMoveLastFrame = now;

    const target = bestMoveTarget();
    // Fade out before moving to a new cell.
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
            depthWrite: false,
        });
        bestMoveMesh = new THREE.Mesh(pieceBaseGeo, material);
        bestMoveMesh.renderOrder = 2;
        scene.add(bestMoveMesh);
    }
    // Re-read every frame: the same cell can stay best while the turn changes.
    const color = sideToMoveOnBoard() === 1 ? BEST_MOVE_LIGHT_COLOR : BEST_MOVE_DARK_COLOR;
    bestMoveMesh.material.color.setHex(color);
    bestMoveMesh.material.emissive.setHex(color);
    // Picks up the loaded bead geometry and piece-size changes.
    if (bestMoveMesh.geometry !== pieceBaseGeo) bestMoveMesh.geometry = pieceBaseGeo;

    const [depth, row, col] = bestMoveCell;
    bestMoveMesh.position.set(col, 3 - depth, row);

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
    controls.update();
    renderer.render(scene, camera);
}

// --- OCCLUSION OVERLAYS ---

// Overlays show only when at least this fraction of a piece is hidden.
const OCCLUSION_COVERAGE_THRESHOLD = 0.6;
const OCCLUSION_SAMPLES = 24;
const OCCLUSION_FADE_MS = 220;
let _ocLastFrameTime = 0;

// Vogel spiral: evenly spread sample points on the unit disc.
const occlusionSamplePoints = (() => {
    const points = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < OCCLUSION_SAMPLES; i++) {
        const r = Math.sqrt((i + 0.5) / OCCLUSION_SAMPLES);
        const a = i * goldenAngle;
        points.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return points;
})();

// Per-frame scratch.
const _ocCenter = new THREE.Vector3();
const _ocEdge = new THREE.Vector3();
const _ocCamRight = new THREE.Vector3();
const _ocDiscs = [];

// Per frame: face the outline rings to the camera, estimate each piece's hidden fraction in
// screen space (sample points against the discs of nearer pieces), and step the fades.
function updateOcclusionOverlays() {
    const now = performance.now();
    // Clamped so a backgrounded tab does not snap the fades.
    const elapsed = _ocLastFrameTime ? Math.min(now - _ocLastFrameTime, 100) : 0;
    _ocLastFrameTime = now;

    if (pieceOverlays.length === 0) return;

    _ocCamRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const aspect = camera.aspect || 1;

    const count = pieceOverlays.length;
    for (let i = 0; i < count; i++) {
        const { piece, ring } = pieceOverlays[i];
        if (ring) {
            ring.position.copy(piece.position);
            ring.quaternion.copy(camera.quaternion);
        }

        const depth = _ocCenter.copy(piece.position).distanceTo(camera.position);

        _ocEdge.copy(piece.position).addScaledVector(_ocCamRight, pieceSilhouetteRadius * piece.scale.x);
        _ocCenter.project(camera);
        _ocEdge.project(camera);

        const disc = _ocDiscs[i] || (_ocDiscs[i] = { x: 0, y: 0, r: 0, depth: 0 });
        // Aspect-corrected NDC, so screen circles stay circles.
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
                if (other.depth >= disc.depth) continue;
                const dx = px - other.x;
                const dy = py - other.y;
                if (dx * dx + dy * dy <= other.r * other.r) { blocked++; break; }
            }
        }

        const overlay = pieceOverlays[i];
        const target = blocked >= needed ? 1 : 0;
        let fade = overlay.fade;
        if (fade < target) fade = Math.min(target, fade + fadeStep);
        else if (fade > target) fade = Math.max(target, fade - fadeStep);
        overlay.fade = fade;
        applyOverlayFade(overlay);
    }
}

function applyOverlayFade(overlay) {
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

// Ease-in, like falling.
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
            const eased = t * t;
            d.mesh.position.y = d.startY + (d.endY - d.startY) * eased;
        }
    }
    // Reveal the win bar once the last piece lands.
    if (activeDrops.length === 0) {
        winHighlights.forEach(m => { m.visible = true; });
    }
}

// --- PUZZLE MODE ---

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
    return toks.some(t => t.length > 2);
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

// Accepts the 2-line (history / solution) and 3-line (board code / history / solution) formats.
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

function openEnginePuzzleSetup() {
    document.getElementById('engine-puzzle-setup').classList.remove('hidden');
    document.getElementById('button-container').classList.add('hidden');
    document.getElementById('engine-puzzle-btn').classList.add('hidden');
    document.getElementById('upload-puzzle-btn').classList.add('hidden');
    refreshMateCounts();
}

function closeEnginePuzzleSetup() {
    document.getElementById('engine-puzzle-setup').classList.add('hidden');
    if (!isPuzzleMode) {
        document.getElementById('button-container').classList.remove('hidden');
        document.getElementById('engine-puzzle-btn').classList.remove('hidden');
        document.getElementById('upload-puzzle-btn').classList.remove('hidden');
    }
}

function renderMateHint(categoryCounts) {
    if (categoryCounts) lastCategoryCounts = categoryCounts;
    const cc = lastCategoryCounts;
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
        const { categories, counts } = await bankSummary();
        if (categories.length) CATEGORIES = categories;
        renderMateHint(counts);
    } catch (e) { /* non-critical */ }
}

async function startEnginePuzzle(category) {
    if (isRequestInProgress) return;
    isRequestInProgress = true;
    const label = categoryLabel(category);
    logMessage(`Picking a ${label.toLowerCase()}...`);
    try {
        const puzzle = await randomPuzzle(category);
        if (!puzzle) {
            logMessage(`No ${label.toLowerCase()} puzzles in the bank.`);
            return;
        }
        puzzles = [puzzle];
        puzzleSource = 'engine';
        selectedCategory = category;
        if (!isPuzzleMode) enterPuzzleMode();
        loadPuzzle(0);
    } catch (e) {
        logMessage('Error loading puzzles: ' + e.message);
    } finally {
        isRequestInProgress = false;
    }
}

function enterPuzzleMode() {
    if (analysis?.enabled) analysis.setEnabled(false);
    isPuzzleMode = true;
    currentPuzzleIndex = 0;
    document.getElementById('engine-puzzle-setup').classList.add('hidden');
    document.getElementById('puzzle-controls').classList.remove('hidden');
    document.getElementById('button-container').classList.add('hidden');
    document.getElementById('engine-puzzle-btn').classList.add('hidden');
    document.getElementById('upload-puzzle-btn').classList.add('hidden');
}

// Split from exitPuzzleMode so a remote exit does not start a new game here.
function leavePuzzleUI() {
    isPuzzleMode = false;
    puzzles = [];
    puzzleSource = null;
    currentPuzzleSolved = false;

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
    startNewGame();   // takes the whole room out of Puzzle Mode
}

function handlePrevPuzzle() {
    if (puzzleSource === 'engine') return;
    loadPuzzle(currentPuzzleIndex - 1);
}

function handleNextPuzzle() {
    if (puzzleSource === 'engine') {
        startEnginePuzzle(selectedCategory);
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
        // The mate distance is deliberately hidden.
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

    const { state } = game.getStateFromMoves(puzzle.history);
    boardState = state;
    moveHistory = [...puzzle.history];
    currentMoveIndex = moveHistory.length;
    updateBoard(boardState);
    updateMoveHistory(moveHistory);

    updatePuzzleInfo();

    const colorName = game.getCurrentPlayer(boardState) === 1 ? PLAYER1_NAME : PLAYER2_NAME;
    const label = puzzleSource === 'engine'
        ? categoryLabel(selectedCategory)
        : `Puzzle ${index + 1}`;
    logMessage(`${label} — ${colorName} to move.`);

    // Unconditional, and the only push that carries the puzzle set.
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

    logMessage('Correct!');
    playMove(column);
    currentPuzzleSolutionIndex++;
    pushBoard({ log: `found column ${columnTag(column)}.` });

    if (currentPuzzleSolutionIndex >= puzzle.solution.length) {
        finishPuzzle();
        return;
    }

    const opponentMove = puzzle.solution[currentPuzzleSolutionIndex];
    isRequestInProgress = true;
    await new Promise(resolve => setTimeout(resolve, 450));
    playMove(opponentMove);
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
        playMove(puzzle.solution[i]);
        currentPuzzleSolutionIndex = i + 1;
        // Pushed per move so other viewers watch it play out.
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
// The model and textures load before init(); either failing falls back to spheres / flat colours.
Promise.all([
    loadPieceModel(PIECE_MODEL_URL).catch((err) =>
        console.warn(`Could not load ${PIECE_MODEL_URL}; falling back to spheres.`, err)),
    loadPieceTextures().catch((err) =>
        console.warn('Could not load the piece textures; falling back to flat colours.', err)),
]).finally(() => init());