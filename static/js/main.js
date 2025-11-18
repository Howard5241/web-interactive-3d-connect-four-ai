import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ConnectFour3D } from './gameLogic.js';

// --- GLOBAL VARIABLES ---
let scene, camera, renderer, controls;
let game; // Game logic instance
let boardState; // Current state of the board
let clickTargets = []; // Invisible planes for detecting clicks
let pieces = []; // To hold the visible game pieces
let previewPiece = null; // To hold the semi-transparent preview piece
let isRequestInProgress = false; // Prevents multiple clicks while waiting for the server
let player1Color = 0xffdc00; // Yellow
let player2Color = 0xf50000; // Red

// DOM Elements (will be assigned in init)
let STATUS_MSG, NEW_GAME_BTN, AI_MOVE_BTN, LOG_BOX, MOVE_HISTORY_BOX, MOVE_INPUT, COPY_HEX_BTN, COPY_MOVES_BTN;
let SETTINGS_BTN, SETTINGS_MODAL_OVERLAY, CLOSE_SETTINGS_BTN;
let PIECE_SIZE_SLIDER, PIECE_SIZE_VALUE, PIECE_OPACITY_SLIDER, PIECE_OPACITY_VALUE;

let gameSettings = {
    pieceSize: 1.0,
    pieceOpacity: 1.0
};

let moveHistory = [];
let currentMoveIndex = 0;

// --- INITIALIZATION ---

function init() {
    // Assign DOM elements
    STATUS_MSG = document.getElementById('status-message');
    NEW_GAME_BTN = document.getElementById('new-game-btn');
    AI_MOVE_BTN = document.getElementById('ai-move-btn');
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

    // Draw Board Structure
    drawBoardGrid();
    createClickTargets();

    // Event Listeners
    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('mousedown', onColumnClick);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    NEW_GAME_BTN.addEventListener('click', startNewGame);
    AI_MOVE_BTN.addEventListener('click', requestAIMove); // Add listener for AI move button
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
        // We need the current board state to redraw
        fetch('/api/game_status').then(res => res.json()).then(data => {
            if (data.board) {
                updateBoard(data.board);
            }
        });
    });

    PIECE_OPACITY_SLIDER.addEventListener('input', (event) => {
        const newOpacity = parseFloat(event.target.value);
        gameSettings.pieceOpacity = newOpacity;
        PIECE_OPACITY_VALUE.textContent = newOpacity.toFixed(1);
        // We need the current board state to redraw
        fetch('/api/game_status').then(res => res.json()).then(data => {
            if (data.board) {
                updateBoard(data.board);
            }
        });
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

// --- 3D BOARD DRAWING --- (No changes in this section)

function drawBoardGrid() {
    const material = new THREE.LineBasicMaterial({ color: 0x555555 });
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

function updateBoard(boardState) {
    // Clear existing pieces
    pieces.forEach(p => scene.remove(p));
    pieces = [];

    // Also remove the preview piece when the board updates
    if (previewPiece) {
        scene.remove(previewPiece);
        previewPiece = null;
    }

    const pieceRadius = 0.4 * gameSettings.pieceSize;
    const pieceGeo = new THREE.SphereGeometry(pieceRadius, 32, 32);
    
    const isTransparent = gameSettings.pieceOpacity < 1.0;

    const player1Mat = new THREE.MeshStandardMaterial({ 
        color: player1Color, 
        roughness: 0.5,
        opacity: gameSettings.pieceOpacity,
        transparent: isTransparent
    });
    const player2Mat = new THREE.MeshStandardMaterial({ 
        color: player2Color, 
        roughness: 0.5,
        opacity: gameSettings.pieceOpacity,
        transparent: isTransparent
    });

    for (let z = 0; z < 4; z++) { // Depth
        for (let y = 0; y < 4; y++) { // Row
            for (let x = 0; x < 4; x++) { // Col
                const pieceValue = boardState[z][y][x];
                if (pieceValue !== 0) {
                    const material = (pieceValue === 1) ? player1Mat : player2Mat;
                    const piece = new THREE.Mesh(pieceGeo, material);
                    piece.position.set(x, 3 - z, y); 
                    scene.add(piece);
                    pieces.push(piece);
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


// --- GAME LOGIC & SERVER COMMUNICATION (MODIFIED) ---

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

async function handlePlayerMove(column) {
    if (isRequestInProgress) return;
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
    boardState = game.getNextState(boardState, column);
    moveHistory.push(column);
    currentMoveIndex++;

    updateBoard(boardState);
    updateMoveHistory(moveHistory);

    // Check for game over locally
    checkGameOver('You win!', 'Your turn! Click a column or let the AI play.');
}

// New function to handle the AI move request
async function requestAIMove() {
    if (isRequestInProgress) return;
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
        
        // The server returns the new state, so we update our local state
        boardState = data.board;
        moveHistory = data.move_history;
        currentMoveIndex = moveHistory.length;

        updateBoard(boardState);
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

async function navigateHistory(direction) {
    const newIndex = currentMoveIndex + direction;

    if (newIndex < 0 || newIndex > moveHistory.length) {
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

    // Sync the new state with the server for the AI
    fetch('/api/set_state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            board_state: boardState,
            move_history: moveHistory
        }),
    })
    .then(response => {
        if (!response.ok) throw new Error('Failed to set the new state on the server.');
        checkGameOver(null, `Viewing the new position. Your turn!`)
    })
    .catch(error => {
        console.error('Error loading from move string:', error);
        logMessage(`Error: ${error.message}`);
    })
    .finally(() => {
        setButtonsDisabled(false);
        isRequestInProgress = false;
    });
}

function handleKeyDown(event) {
    // Prevent arrow key navigation when the input is focused
    if (document.activeElement === MOVE_INPUT) {
        return;
    }
    if (isRequestInProgress) return;

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
        handlePlayerMove(clickedColumn);
    }
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
    controls.update(); // only required if controls.enableDamping = true
    renderer.render(scene, camera);
}

// --- START ---
init();