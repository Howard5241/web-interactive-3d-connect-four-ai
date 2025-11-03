import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- GLOBAL VARIABLES ---
let scene, camera, renderer, controls;
let clickTargets = []; // Invisible planes for detecting clicks
let pieces = []; // To hold the visible game pieces
let isRequestInProgress = false; // Prevents multiple clicks while waiting for the server

const STATUS_MSG = document.getElementById('status-message');
const NEW_GAME_BTN = document.getElementById('new-game-btn');
const AI_MOVE_BTN = document.getElementById('ai-move-btn'); // Get the new button
const LOG_BOX = document.getElementById('log-box');
const MOVE_HISTORY_BOX = document.getElementById('move-history-box');
const MOVE_INPUT = document.getElementById('move-input');

let moveHistory = [];
let currentMoveIndex = 0;

// --- INITIALIZATION ---

function init() {
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
    NEW_GAME_BTN.addEventListener('click', startNewGame);
    AI_MOVE_BTN.addEventListener('click', requestAIMove); // Add listener for AI move button
    window.addEventListener('keydown', handleKeyDown);
    MOVE_INPUT.addEventListener('keydown', handleMoveInputChange);

    // Start Animation Loop
    animate();
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

    const pieceGeo = new THREE.SphereGeometry(0.4, 32, 32);
    const player1Mat = new THREE.MeshStandardMaterial({ color: 0xffdc00, roughness: 0.5 }); // Yellow
    const player2Mat = new THREE.MeshStandardMaterial({ color: 0xf50000, roughness: 0.5 }); // Red

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

async function startNewGame() {
    logMessage('Starting new game...');
    setButtonsDisabled(true);
    isRequestInProgress = true;

    try {
        const response = await fetch('/api/new_game', { method: 'POST' });
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();
        updateBoard(data.board);
        currentMoveIndex = 0;
        updateMoveHistory(data.move_history);
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

    isRequestInProgress = true;
    // If the current board state indicates game over, do not proceed
    const gameStatusResponse = await fetch('/api/game_status');
    const gameStatus = await gameStatusResponse.json();
    if (gameStatus.status === 'Game Over') {
        logMessage('Game is over. Please start a new game.');
        isRequestInProgress = false;
        return;
    }
    setButtonsDisabled(true);
    logMessage('Processing your move...');

    try {
        const response = await fetch('/api/player_move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ column: column }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Invalid move or server error.');
        }

        const data = await response.json();
        updateBoard(data.board);
        currentMoveIndex = data.move_history.length;
        updateMoveHistory(data.move_history);

        if (data.status === 'Game Over') {
            if (data.winner === 'Draw') {
                logMessage('It\'s a draw!');
            } else {
                logMessage('Congratulations, you win! 🎉');
            }
            AI_MOVE_BTN.disabled = true; // Game is over, disable AI move
            NEW_GAME_BTN.disabled = false; // Enable new game button
        } else {
            logMessage('Your turn! Click a column or let the AI play.');
            setButtonsDisabled(false); // Re-enable for next move
        }

    } catch (error) {
        console.error('Error during player move:', error);
        logMessage(`Error: ${error.message}`);
        setButtonsDisabled(false); // Re-enable on error
    } finally {
        isRequestInProgress = false;
    }
}

// New function to handle the AI move request
async function requestAIMove() {
    if (isRequestInProgress) return;
    if (currentMoveIndex !== moveHistory.length) {
        logMessage('You must be at the most recent move to play.');
        return;
    }

    isRequestInProgress = true;
    setButtonsDisabled(true);
    logMessage('AI is thinking... 🤔');

    try {
        // Add a small delay for better UX
        await new Promise(resolve => setTimeout(resolve, 500)); 
        
        const response = await fetch('/api/ai_move', { method: 'POST' });
        if (!response.ok) throw new Error('AI server error.');
        
        const data = await response.json();
        updateBoard(data.board);
        currentMoveIndex = data.move_history.length;
        updateMoveHistory(data.move_history);

        if (data.status === 'Game Over') {
            if (data.winner === 'Draw') {
                logMessage('It\'s a draw!');
            } else {
                logMessage('AI wins! Better luck next time. 🤖');
            }
            AI_MOVE_BTN.disabled = true; // Game is over
            NEW_GAME_BTN.disabled = false; // Enable new game button
        } else {
            logMessage('Your turn! Click a column or let the AI play.');
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

    setButtonsDisabled(true); // Disable buttons during navigation
    isRequestInProgress = true;

    const movesToDisplay = moveHistory.slice(0, currentMoveIndex);
    const movesString = movesToDisplay.join(',');

    try {
        const response = await fetch(`/api/state_from_moves/${movesString}`);
        if (!response.ok) throw new Error('Failed to fetch historical state.');
        
        const data = await response.json();
        updateBoard(data.board);
        updateMoveHistory(moveHistory); // Redraw to update highlighting

        if (isViewingLive) {
            logMessage('Viewing the most recent move. Your turn!');
            setButtonsDisabled(false); // Re-enable buttons
        } else {
            logMessage(`Viewing move ${currentMoveIndex} of ${moveHistory.length}.`);
        }

    } catch (error) {
        console.error('Error navigating history:', error);
        logMessage('Error: Could not load position.');
    } finally {
        // Only re-enable buttons if we are back at the live position
        if (currentMoveIndex === moveHistory.length) {
            setButtonsDisabled(false);
        }
        isRequestInProgress = false;
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

    // Convert space-separated numbers to a comma-separated string for the API
    const movesForApi = movesString.split(/\s+/).join(',');

    // Immediately clear the input and show loading state
    MOVE_INPUT.value = '';
    logMessage(`Loading position from moves: ${movesString}`);
    setButtonsDisabled(true);
    isRequestInProgress = true;

    let newBoardState;
    let appliedMoves;

    // Step 1: Get the state from the moves string
    fetch(`/api/state_from_moves/${movesForApi}`)
        .then(response => {
            if (!response.ok) throw new Error('Failed to fetch state from moves.');
            return response.json();
        })
        .then(data => {
            if (data.error) {
                logMessage(`Warning: ${data.error}`);
            }
            newBoardState = data.board;
            appliedMoves = data.moves_applied;

            // Step 2: Set the new state on the server's session
            return fetch('/api/set_state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    board_state: newBoardState,
                    move_history: appliedMoves
                }),
            });
        })
        .then(response => {
            if (!response.ok) throw new Error('Failed to set the new state on the server.');
            
            // Step 3: Update the UI now that the server state is synced
            logMessage('Board updated to the specified position.');
            updateBoard(newBoardState);
            currentMoveIndex = appliedMoves.length;
            updateMoveHistory(appliedMoves);

            // Step 4: Check the status of the new board state
            return fetch('/api/game_status');
        })
        .then(response => response.json())
        .then(statusData => {
            if (statusData.status === 'Game Over') {
                logMessage(`Game is over. Winner: ${statusData.winner}`);
                AI_MOVE_BTN.disabled = true;
            } else {
                logMessage('Viewing the new position. Your turn!');
            }
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

function animate() {
    requestAnimationFrame(animate);
    controls.update(); // only required if controls.enableDamping = true
    renderer.render(scene, camera);
}

// --- START ---
init();