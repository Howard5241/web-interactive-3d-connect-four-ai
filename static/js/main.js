import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- GLOBAL VARIABLES ---
let scene, camera, renderer, controls;
let clickTargets = []; // Invisible planes for detecting clicks
let pieces = []; // To hold the visible game pieces
let isPlayerTurn = false;

const STATUS_MSG = document.getElementById('status-message');
const NEW_GAME_BTN = document.getElementById('new-game-btn');

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

    // Start Animation Loop
    animate();
}

// --- 3D BOARD DRAWING ---

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
    const playerMat = new THREE.MeshStandardMaterial({ color: 0xff4136, roughness: 0.5 }); // Red
    const aiMat = new THREE.MeshStandardMaterial({ color: 0xffdc00, roughness: 0.5 }); // Yellow

    for (let z = 0; z < 4; z++) { // Depth
        for (let y = 0; y < 4; y++) { // Row
            for (let x = 0; x < 4; x++) { // Col
                const pieceValue = boardState[z][y][x];
                if (pieceValue !== 0) {
                    const material = (pieceValue === 1) ? playerMat : aiMat;
                    const piece = new THREE.Mesh(pieceGeo, material);
                    // Map array indices to 3D scene coordinates
                    // Our array is (depth, row, col), scene is (x, y, z)
                    // Scene Y is our board depth (z-index)
                    piece.position.set(x, 3 - z, y); // Invert z for top-down board
                    scene.add(piece);
                    pieces.push(piece);
                }
            }
        }
    }
}


// --- GAME LOGIC & SERVER COMMUNICATION (MODIFIED SECTION) ---

async function startNewGame() {
    STATUS_MSG.textContent = 'Starting new game...';
    try {
        const response = await fetch('/api/new_game', { method: 'POST' });
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();
        updateBoard(data.board);
        STATUS_MSG.textContent = 'Your turn! Click a column to play.';
        isPlayerTurn = true;
    } catch (error) {
        console.error('Error starting new game:', error);
        STATUS_MSG.textContent = 'Error: Could not start new game.';
    }
}

// THIS FUNCTION IS REWRITTEN
async function handlePlayerMove(column) {
    if (!isPlayerTurn) return;

    isPlayerTurn = false; // Disable clicks immediately
    STATUS_MSG.textContent = 'Processing your move...';

    try {
        // --- Call 1: Send player's move and get instant feedback ---
        const playerResponse = await fetch('/api/player_move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ column: column }),
        });

        if (!playerResponse.ok) {
            const errorData = await playerResponse.json();
            throw new Error(errorData.error || 'Invalid move or server error.');
        }

        const playerData = await playerResponse.json();
        
        // INSTANT UPDATE: Show the player's piece on the board
        updateBoard(playerData.board);

        // Check if the player's move ended the game
        if (playerData.status === 'Game Over') {
            if (playerData.winner === 'Player') {
                STATUS_MSG.textContent = 'Congratulations, you win! 🎉';
            } else {
                STATUS_MSG.textContent = 'It\'s a draw!';
            }
            return; // Stop execution, the game is over
        }

        // --- If game is not over, proceed to get AI's move ---
        STATUS_MSG.textContent = 'AI is thinking... 🤔';
        
        // Add a small delay for better UX, makes the AI feel like it's "thinking"
        await new Promise(resolve => setTimeout(resolve, 500)); 
        
        // --- Call 2: Ask the server to compute the AI's move ---
        const aiResponse = await fetch('/api/ai_move', { method: 'POST' });
        if (!aiResponse.ok) throw new Error('AI server error.');
        
        const aiData = await aiResponse.json();

        // UPDATE AGAIN: Show the AI's piece on the board
        updateBoard(aiData.board);

        // Check if the AI's move ended the game
        if (aiData.status === 'Game Over') {
             if (aiData.winner === 'AI') {
                STATUS_MSG.textContent = 'The AI wins! Better luck next time.';
            } else {
                STATUS_MSG.textContent = 'It\'s a draw!';
            }
        } else {
            // Game continues, it's the player's turn again
            STATUS_MSG.textContent = 'Your turn!';
            isPlayerTurn = true;
        }

    } catch (error) {
        console.error('Error during game turn:', error);
        STATUS_MSG.textContent = `Error: ${error.message}`;
        isPlayerTurn = true; // Allow player to try again
    }
}


// --- EVENT HANDLERS & ANIMATION ---

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function onColumnClick(event) {
    if (!isPlayerTurn) return;

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