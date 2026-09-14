export class ConnectFour3D {
    constructor() {
        this.rows = 4;
        this.cols = 4;
        this.depth = 4;
        this.gridShape = [this.depth, this.rows, this.cols];
        this.numCells = this.depth * this.rows * this.cols; // 64
        this.numColumns = this.rows * this.cols; // 16
        this.numActions = this.rows * this.cols; // 16

        // _winningPatterns[i] is a bitmask; _winningLines[i] holds the same four cells as
        // [z, y, x] coordinates, so a completed pattern can be traced back to the board.
        const { patterns, lines } = this._generateWinningPatterns();
        this._winningPatterns = patterns;
        this._winningLines = lines;
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

    // Every four-in-a-row currently on the board, as
    // [{ player, cells: [[z, y, x] x4] }]. A single move can complete more than one line,
    // so all of them are returned.
    getWinningLines(state) {
        const found = [];
        const boards = [[1, this._createBitboard(state, 1)], [-1, this._createBitboard(state, -1)]];
        for (let i = 0; i < this._winningPatterns.length; i++) {
            const pattern = this._winningPatterns[i];
            for (const [player, bitboard] of boards) {
                if ((bitboard & pattern) === pattern) {
                    found.push({ player, cells: this._winningLines[i] });
                    break;   // a cell cannot hold both players, so at most one can match
                }
            }
        }
        return found;
    }

    // The four-in-a-row running through two distinct cells, as [[z, y, x] x4] in order
    // along the line, or null if no winning line contains both. Two distinct points fix a
    // straight line, so there is never more than one answer.
    findLineThrough(a, b) {
        if (!a || !b) return null;
        const holds = (cells, c) =>
            cells.some(([z, y, x]) => z === c[0] && y === c[1] && x === c[2]);
        if (holds([a], b)) return null;   // the same cell twice names no line
        for (const cells of this._winningLines) {
            if (holds(cells, a) && holds(cells, b)) return cells;
        }
        return null;
    }

    _generateWinningPatterns() {
        // Keyed by bitmask so the same four cells reached from opposite directions collapse
        // to one entry, exactly as the old Set did.
        const patterns = new Map();
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
                            const cells = [];
                            for (let i = 0; i < 4; i++) {
                                const nx = x + i * dx;
                                const ny = y + i * dy;
                                const nz = z + i * dz;
                                const pos = BigInt(nz * this.numColumns + ny * this.cols + nx);
                                mask |= (1n << pos);
                                cells.push([nz, ny, nx]);
                            }
                            if (!patterns.has(mask)) patterns.set(mask, cells);
                        }
                    }
                }
            }
        }
        return { patterns: Array.from(patterns.keys()), lines: Array.from(patterns.values()) };
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
