export class ConnectFour3D {
    constructor() {
        this.rows = 4;
        this.cols = 4;
        this.depth = 4;
        this.gridShape = [this.depth, this.rows, this.cols];
        this.numCells = this.depth * this.rows * this.cols; // 64
        this.numColumns = this.rows * this.cols; // 16
        this.numActions = this.rows * this.cols; // 16

        this._winningPatterns = this._generateWinningPatterns();
    }

    getInitialState() {
        return Array(this.depth).fill(0).map(() => Array(this.rows).fill(0).map(() => Array(this.cols).fill(0)));
    }

    getNumPieces(state) {
        return state.flat(2).filter(p => p !== 0).length;
    }

    getCurrentPlayer(state) {
        const numPlayer1Pieces = state.flat(2).filter(p => p === 1).length;
        const numPlayer2Pieces = state.flat(2).filter(p => p === -1).length;
        return numPlayer1Pieces === numPlayer2Pieces ? 1 : -1;
    }

    getValidMoves(state) {
        return state[0].flat().map(cell => (cell === 0 ? 1 : 0));
    }

    getValueAndTerminated(state) {
        if (this.checkGameOver(state)) {
            return [-1, true];
        }
        if (this.getValidMoves(state).every(move => move === 0)) {
            return [0, true];
        }
        return [0, false];
    }

    getNextState(state, action) {
        const nextState = JSON.parse(JSON.stringify(state)); // Deep copy
        const { row, col } = this._actionToCoords(action);

        let depth = -1;
        for (let d = this.depth - 1; d >= 0; d--) {
            if (state[d][row][col] === 0) {
                depth = d;
                break;
            }
        }
        
        if (depth !== -1) {
            nextState[depth][row][col] = this.getCurrentPlayer(state);
        }

        return nextState;
    }

    checkWin(state) {
        const lastPlayer = -this.getCurrentPlayer(state);
        const playerBitboard = this._createBitboard(state, lastPlayer);
        for (const pattern of this._winningPatterns) {
            if ((playerBitboard & pattern) === pattern) {
                return true;
            }
        }
        return false;
    }

    checkGameOver(state) {
        const lastPlayer = -this.getCurrentPlayer(state);
        const currentPlayer = this.getCurrentPlayer(state);
        const lastPlayerBitboard = this._createBitboard(state, lastPlayer);
        const currentPlayerBitboard = this._createBitboard(state, currentPlayer);

        for (const pattern of this._winningPatterns) {
            if ((lastPlayerBitboard & pattern) === pattern || (currentPlayerBitboard & pattern) === pattern) {
                return true;
            }
        }

        return this.getNumPieces(state) === this.numCells;
    }

    getStateFromMoves(moves) {
        let state = this.getInitialState();
        const appliedMoves = [];
        for (const action of moves) {
            if (!(action >= 0 && action < this.numActions)) {
                break;
            }
            const validMoves = this.getValidMoves(state);
            if (validMoves[action] === 0) {
                break;
            }
            state = this.getNextState(state, action);
            appliedMoves.push(action);
            if (this.checkGameOver(state)) {
                break;
            }
        }
        return { state, appliedMoves };
    }

    getLandingPosition(state, action) {
        if (!(action >= 0 && action < this.numActions) || this.getValidMoves(state)[action] === 0) {
            return null;
        }
        const { row, col } = this._actionToCoords(action);
        for (let d = this.depth - 1; d >= 0; d--) {
            if (state[d][row][col] === 0) {
                return [d, row, col];
            }
        }
        return null;
    }

    getStateHexCode(state) {
        const player1Bitboard = this._createBitboardFlipped(state, 1);
        const player2Bitboard = this._createBitboardFlipped(state, -1);
        const p1Hex = player1Bitboard.toString(16).padStart(16, '0');
        const p2Hex = player2Bitboard.toString(16).padStart(16, '0');
        return `${p1Hex} ${p2Hex}`;
    }

    _generateWinningPatterns() {
        const patterns = new Set();
        const directions = [
            [1, 0, 0], [0, 1, 0], [0, 0, 1],
            [1, 1, 0], [1, -1, 0], [1, 0, 1],
            [1, 0, -1], [0, 1, 1], [0, 1, -1],
            [1, 1, 1], [1, -1, 1], [1, 1, -1], [1, -1, -1]
        ];

        for (let z = 0; z < this.depth; z++) {
            for (let y = 0; y < this.rows; y++) {
                for (let x = 0; x < this.cols; x++) {
                    for (const [dx, dy, dz] of directions) {
                        const endX = x + 3 * dx;
                        const endY = y + 3 * dy;
                        const endZ = z + 3 * dz;

                        if (endX >= 0 && endX < this.cols &&
                            endY >= 0 && endY < this.rows &&
                            endZ >= 0 && endZ < this.depth) {
                            
                            let mask = 0n;
                            for (let i = 0; i < 4; i++) {
                                const nx = x + i * dx;
                                const ny = y + i * dy;
                                const nz = z + i * dz;
                                const pos = BigInt(nz * this.numColumns + ny * this.cols + nx);
                                mask |= (1n << pos);
                            }
                            patterns.add(mask);
                        }
                    }
                }
            }
        }
        return Array.from(patterns);
    }

    _createBitboard(state, player) {
        let bitboard = 0n;
        for (let z = 0; z < this.depth; z++) {
            for (let y = 0; y < this.rows; y++) {
                for (let x = 0; x < this.cols; x++) {
                    if (state[z][y][x] === player) {
                        const pos = BigInt(z * this.numColumns + y * this.cols + x);
                        bitboard |= (1n << pos);
                    }
                }
            }
        }
        return bitboard;
    }
    _createBitboardFlipped(state, player) {
        let bitboard = 0n;
        for (let z = 0; z < this.depth; z++) {
            for (let y = 0; y < this.rows; y++) {
                for (let x = 0; x < this.cols; x++) {
                    if (state[z][y][x] === player) {
                        const pos = BigInt((3-z) * this.numColumns + y * this.cols + x);
                        bitboard |= (1n << pos);
                    }
                }
            }
        }
        return bitboard;
    }

    _actionToCoords(action) {
        if (action < 0 || action >= this.numActions) {
            throw new Error(`Action must be between 0 and ${this.numActions - 1}.`);
        }
        const row = Math.floor(action / this.cols);
        const col = action % this.cols;
        return { row, col };
    }
}
