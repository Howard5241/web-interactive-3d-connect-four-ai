import collections
from tqdm.notebook import trange, tqdm
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import itertools
import csv
import os
import glob
import re
import imageio
from PIL import Image
import io
class ConnectFour3D():
    """
    A class to represent and manage a 3D Connect Four game.
    
    The 'basic' board state uses:
     -  1: First Player
     - -1: Second Player
     -  0: Empty Space
     
    The current player is determined dynamically by the number of pieces on the board.
    """
    def __init__(self):
        self.rows = 4
        self.cols = 4
        self.depth = 4
        self.grid_shape = (self.depth, self.rows, self.cols)
        self.num_cells = self.depth * self.rows * self.cols  # 64
        self.num_columns = self.rows * self.cols # 16
        self.num_actions = self.rows * self.cols  # 16 possible column drops

        # Pre-calculate all 76 possible winning lines on the 4x4x4 board.
        # Storing these as a NumPy array allows for easy transfer to a GPU.
        self._winning_patterns = self._generate_winning_patterns()


    def get_initial_state(self)-> np.ndarray: 
        """Returns the initial empty board state."""
        return np.zeros(self.grid_shape, dtype=np.int8)
    
    def get_num_pieces(self, state: np.ndarray) -> int:
        """Returns the total number of pieces on the board."""
        return np.count_nonzero(state != 0)

    def get_current_player(self, state: np.ndarray = None) -> int:
        """
        Determines whose turn it is based on the current board state.
        Return 1 if it's Player 1's turn else return -1 for Player 2
        """
        num_player1_pieces = np.count_nonzero(state == 1)
        num_player2_pieces = np.count_nonzero(state == -1)
        return 1 if num_player1_pieces == num_player2_pieces else -1

    def get_valid_moves(self, state) -> np.ndarray:
        return (state[0] == 0).flatten().astype(np.uint8)
    
    def get_value_and_terminated(self, state)-> tuple[int, bool]:
        # This check is for the player who made the LAST move.
        if self.check_win(state):
            return -1, True # The CURRENT player has lost, so the value from their perspective is -1.
        # This check is for a draw, where the value is 0. This is correct.
        if np.sum(self.get_valid_moves(state)) == 0:
            return 0, True
        # Game is ongoing, value is 0 for now. This is correct.
        return 0, False
    
    def get_next_state(self, state, action):
        next_state = np.copy(state)
        row, col = self._action_to_coords(action)

        depth = np.max(np.where(state[:, row, col] == 0))
        next_state[depth, row, col] = self.get_current_player(state)

        return next_state

    def get_encoded_state(self, state):
        """
        Converts the basic board state into a multi-plane tensor for the NN.
        This representation is from a fixed perspective (Player 1 vs Player 2).

        Returns:
            A numpy array of shape (4, 4, 4, 4) representing the encoded state.
            The dimensions are (channels, depth, height, width).
        """
        # Plane 1: First Player's Pieces (value 1)
        player1_pieces = (state == 1).astype(np.float32)
        # Plane 2: Second Player's Pieces (value -1)
        player2_pieces = (state == -1).astype(np.float32)
        # Plane 3: Empty Spaces (value 0)
        empty_spaces = (state == 0).astype(np.float32)
        # Plane 4: Player-to-Move "Color"
        # Determine turn dynamically and create the plane
        if self.get_current_player(state) == 1:
            turn_plane = np.ones(state.shape, dtype=np.float32)
        else:
            turn_plane = np.zeros(state.shape, dtype=np.float32)
            
        # Stack the planes along a new channel axis (axis=0)
        return np.stack(
            [player1_pieces, player2_pieces, empty_spaces, turn_plane], 
            axis=0
        )

    def print_board(self, state):
        print(self.get_board_string(), state)

    def get_board_string(self, state) -> str:
        """Returns a human-readable string representation of the 3D board."""
        s = "--- 3D Connect Four Board ---\n"
        for z in range(4):
            s += f"\nLayer {z}:\n"
            for r_idx, row in enumerate(state[z, :, :]):
                s += f" ".join([f"{int(p):2}" for p in row]) + "\n"
        
        player = self.get_current_player(state)
        s += f"\nTurn: Player {'1 (X)' if player == 1 else '2 (O)'}\n"
        s += "-----------------------------\n"
        return s

    def check_win(self, state: np.ndarray) -> bool:
        """Checks if the last move resulted in a win (concise vectorized version)."""
        last_player = -self.get_current_player(state)
        player_bitboard = self._create_bitboard(state, last_player)
        return bool(np.any((player_bitboard & self._winning_patterns) == self._winning_patterns))
    
    def check_game_over(self, state: np.ndarray) -> bool:
        """Checks if the game is over due to a win or a draw."""
        last_player = -self.get_current_player(state)
        current_player = self.get_current_player(state)
        last_player_bitboard = self._create_bitboard(state, last_player)
        current_player_bitboard = self._create_bitboard(state, current_player)

        return bool(np.any((last_player_bitboard & self._winning_patterns) == self._winning_patterns)) or \
                bool(np.any((current_player_bitboard & self._winning_patterns) == self._winning_patterns)) or \
                    self.get_num_pieces(state) == self.num_cells
    
    def get_state_from_moves(self, moves: list[int]) -> tuple[np.ndarray, list[int]]:
        """
        Generates a state from a list of moves with validation.

        Args:
            moves (list[int]): A list of action integers.

        Returns:
            A tuple containing:
            - np.ndarray: The resulting board state.
            - list[int]: The list of moves that were successfully applied.
        """
        state = self.get_initial_state()
        applied_moves = []
        for action in moves:
            if not (0 <= action < self.num_actions):
                break # Stop if move is out of bounds
            
            valid_moves = self.get_valid_moves(state)
            if valid_moves[action] == 0:
                break # Stop if move is invalid for the current state

            state = self.get_next_state(state, action)
            applied_moves.append(action)
            if self.check_game_over(state):
                break # Stop if the game is over
        return state, applied_moves
    
    def get_landing_position(self, state: np.ndarray, action: int) -> tuple[int, int, int] | None:
        """
        Calculates the landing position (depth, row, col) for a given action.
        Returns None if the column is full.
        """
        if not (0 <= action < self.num_actions) or self.get_valid_moves(state)[action] == 0:
            return None
        
        row, col = self._action_to_coords(action)
        
        try:
            # Find the deepest index in the column that is empty (0)
            depth = np.max(np.where(state[:, row, col] == 0))
            return (depth, row, col)
        except ValueError:
            # This occurs if np.where returns an empty array (column is full)
            return None

    def get_symmetries(self, state: np.ndarray, policy: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
        """
        Generates symmetrical versions of a state and its corresponding policy.
        This implementation provides the 8 symmetries of the square (rotations and flips).

        Args:
            state (np.ndarray): The (4, 4, 4) board state.
            policy (np.ndarray): The (16,) policy vector.

        Returns:
            A list of tuples, where each tuple contains a (symmetric_state, symmetric_policy).
        """
        symmetries = []
        policy_grid = policy.reshape(self.rows, self.cols)
        # Iterate through 4 rotations (0, 90, 180, 270 degrees)
        for k in range(4):
            # Rotate the state's height and width axes
            rotated_state = np.rot90(state, k, axes=(1, 2))
            
            # Rotate the policy grid's row and column axes
            rotated_policy_grid = np.rot90(policy_grid, k, axes=(0, 1))

            # Symmetry 1: Just the rotation
            symmetries.append((rotated_state, rotated_policy_grid.flatten()))

            # Symmetry 2: Rotation followed by a flip (left-to-right)
            # Flip the state across its width axis
            flipped_rotated_state = np.flip(rotated_state, axis=2)
            
            # Flip the policy grid across its column axis
            flipped_rotated_policy_grid = np.flip(rotated_policy_grid, axis=1)
            
            symmetries.append((flipped_rotated_state, flipped_rotated_policy_grid.flatten()))
        
        # Remove any potential duplicates that might arise from perfectly symmetrical states
        unique_symmetries = []
        seen_states = set()
        for s, p in symmetries:
            s_bytes = s.tobytes() # Convert array to a hashable bytes object
            if s_bytes not in seen_states:
                unique_symmetries.append((s, p))
                seen_states.add(s_bytes)
        
        return unique_symmetries
    def get_basic_state_from_encoded_state(self, encoded_state: np.ndarray) -> np.ndarray:
        """
        Converts an encoded state back to the basic board representation.
        
        Args:
            encoded_state (np.ndarray): The (4, 4, 4, 4) encoded state.
        
        Returns:
            np.ndarray: The (4, 4, 4) basic board state.
        """
        basic_state = self.get_initial_state()
        
        # Plane 1: First Player's Pieces (value 1)
        basic_state[encoded_state[0] == 1] = 1
        # Plane 2: Second Player's Pieces (value -1)
        basic_state[encoded_state[1] == 1] = -1
        # Plane 3: Empty Spaces (value 0) - already initialized to 0
        return basic_state
    
    def get_state_from_hex(self, hex_p1: str, hex_p2: str) -> np.ndarray:
        """
        Reconstructs the board state from two 64-bit hex strings,
        accounting for the flipped z-axis from the JavaScript implementation.
        """
        state = self.get_initial_state()
        
        p1_bitboard = np.uint64(int(hex_p1, 16))
        p2_bitboard = np.uint64(int(hex_p2, 16))

        for i in range(self.num_cells):
            pos = np.uint64(1) << np.uint64(i)
            
            if (p1_bitboard & pos):
                # Reverse the mapping from JS: pos = (3-z)*16 + y*4 + x
                z_flipped = i // 16
                z = 3 - z_flipped
                y = (i % 16) // 4
                x = i % 4
                state[z, y, x] = 1
            
            if (p2_bitboard & pos):
                z_flipped = i // 16
                z = 3 - z_flipped
                y = (i % 16) // 4
                x = i % 4
                state[z, y, x] = -1
                
        return state

    def _generate_winning_patterns(self) -> np.ndarray:
        """
        Generates all winning patterns as bitmasks for a 4x4x4 cube.
        A winning line is any set of 4 cells in a row in any direction.
        This is a Python translation of the provided C++ reference function.
        """
        patterns = set()
        # 13 directions to check for a line of 4.
        directions = [
            (1, 0, 0), (0, 1, 0), (0, 0, 1),
            (1, 1, 0), (1, -1, 0), (1, 0, 1),
            (1, 0, -1), (0, 1, 1), (0, 1, -1),
            (1, 1, 1), (1, -1, 1), (1, 1, -1), (1, -1, -1)
        ]

        for z in range(self.depth):
            for y in range(self.rows):
                for x in range(self.cols):
                    for dx, dy, dz in directions:
                        # Check if a line of 4 fits within the board boundaries
                        end_x, end_y, end_z = x + 3 * dx, y + 3 * dy, z + 3 * dz
                        if not (0 <= end_x < self.cols and
                                0 <= end_y < self.rows and
                                0 <= end_z < self.depth):
                            continue

                        mask = np.uint64(0)
                        for i in range(4):
                            nx, ny, nz = x + i * dx, y + i * dy, z + i * dz
                            pos = nz * self.num_columns + ny * self.cols + nx
                            mask |= np.uint64(1) << np.uint64(pos)
                        patterns.add(mask)

        return np.array(list(patterns), dtype=np.uint64)
    
    def _create_bitboard(self, state: np.ndarray, player: int) -> np.uint64:
        """Create a 64-bit bitboard for `player` using a vectorized dot-product.

        The board layout matches the existing position encoding used elsewhere
        (z major, then y, then x), so flattening in C-order produces the correct
        bit positions: pos = z * num_columns + y * cols + x.
        """
        mask = (state == player).astype(np.uint64).ravel()
        powers = (np.uint64(1) << np.arange(self.num_cells, dtype=np.uint64))
        # Dot product of 0/1 mask with powers yields the bitboard
        return np.uint64(np.dot(mask, powers))
    
    def _action_to_coords(self, action: int) -> tuple[int, int]:
        """Converts a flat action index (0-15) to (row, col) coordinates."""
        if not 0 <= action < self.num_actions:
            raise ValueError(f"Action must be between 0 and {self.num_actions - 1}.")
        row = action // self.cols
        col = action % self.cols
        return row, col


    def _plot_3d_scatter(self, state, ax, title, label1: str, label2: str):
        """
        Helper function to draw the 3D scatter plot of the board on a given axis.
        Dots are scaled to appear smaller the further they are from the camera.
        """
        # --- Perspective Scaling Logic ---
        # Get viewing angles from the axis object (in degrees) and convert to radians
        elev_rad = np.deg2rad(ax.elev)
        azim_rad = np.deg2rad(ax.azim)

        # The view vector points from the scene's center towards the camera.
        # A larger dot product means a point is "closer" to the camera.
        view_vec = np.array([
            np.cos(elev_rad) * np.cos(azim_rad),
            np.cos(elev_rad) * np.sin(azim_rad),
            np.sin(elev_rad)
        ])

        # Define the center of the board for calculating relative positions
        center = np.array([1.5, 1.5, 1.5])

        # Find min/max projection values for the cube's corners to normalize distances
        corners = np.array(list(itertools.product([0, 3], repeat=3)))
        dists = np.dot(corners - center, view_vec)
        min_dist, max_dist = np.min(dists), np.max(dists)

        # Define the size range for the markers
        min_size, max_size = 80, 220
        # --- End of Scaling Logic ---

        # Collect points and their properties to plot them efficiently in batches
        p1_coords, p2_coords = [], []
        p1_sizes, p2_sizes = [], []

        for z in range(self.depth):
            for y in range(self.rows):
                for x in range(self.cols):
                    if state[z, y, x] == 1 or state[z, y, x] == -1:
                        point = np.array([x, y, z])
                        
                        # Calculate projection of the point's vector onto the view vector
                        dist_along_view = np.dot(point - center, view_vec)
                        
                        # Normalize this distance to a [0, 1] range (1 is closest)
                        norm_dist = (dist_along_view - min_dist) / (max_dist - min_dist) if (max_dist - min_dist) != 0 else 0.5
                        
                        # Map the normalized distance to the desired size range
                        size = min_size + (max_size - min_size) * norm_dist
                        
                        if state[z, y, x] == 1:
                            p1_coords.append(point)
                            p1_sizes.append(size)
                        else: # state[z, y, x] == -1
                            p2_coords.append(point)
                            p2_sizes.append(size)

        # Plot all Player 1 pieces in a single, efficient call
        if p1_coords:
            coords = np.array(p1_coords)
            ax.scatter(coords[:, 0], coords[:, 1], coords[:, 2], c='red', s=p1_sizes, 
                       marker='o', label=f"{label1} (P1)", depthshade=True)

        # Plot all Player 2 pieces in a single, efficient call
        if p2_coords:
            coords = np.array(p2_coords)
            ax.scatter(coords[:, 0], coords[:, 1], coords[:, 2], c='blue', s=p2_sizes, 
                       marker='o', label=f"{label2} (P2)", depthshade=True)
        
        ax.set_title(title, x=0.4)
        ax.set_xlabel('X (Column)')
        ax.set_ylabel('Y (Row)')
        ax.set_zlabel('Z (Depth)')
        ax.set_xticks(range(4))
        ax.set_yticks(range(4))
        ax.set_zticks(range(4))
        ax.set_box_aspect([1, 1, 1]) # Make the plot cubic
        ax.invert_zaxis() # Puts z=0 at the top, matching board representation
        
        if p1_coords or p2_coords:
            ax.legend(loc='upper right', bbox_to_anchor=(1, 1.15))

    def plot_board(self, state, title="", args: dict = {}):
        """
        Visualizes the current board state. If a title is provided, it does
        not call plt.show(), making it suitable for replay generation.
        """
        P1_name = args.get('label1', 'Player 1')
        P2_name = args.get('label2', 'Player 2')
        fig = plt.figure(figsize=(12, 6))
        main_title = title if title else 'Current Board State'
        fig.suptitle(main_title, fontsize=16)

        # 1. Text representation
        ax_text = fig.add_subplot(131)
        ax_text.text(0.05, 0.95, self.get_board_string(state), family='monospace', va='top', fontsize=11)
        ax_text.axis('off')

        # 2. First 3D perspective
        ax3d_1 = fig.add_subplot(132, projection='3d')
        self._plot_3d_scatter(state, ax3d_1, "Perspective 1", P1_name, P2_name)
        ax3d_1.view_init(elev=20, azim=-65) 

        # 3. Second 3D perspective
        ax3d_2 = fig.add_subplot(133, projection='3d')
        self._plot_3d_scatter(state, ax3d_2, "Perspective 2", P1_name, P2_name)
        ax3d_2.view_init(elev=20, azim=-40)
            
        plt.tight_layout(rect=[0, 0.03, 1, 0.95])
        
        # Only show the plot if not generating a replay frame
        if not title:
            plt.show()