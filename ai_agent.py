import random
import collections
from tqdm.notebook import trange, tqdm
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import torch
import torch.nn as nn
import torch.nn.functional as F
import itertools
import csv
import os
import glob
import re
from PIL import Image
import io
import math
from game_logic import ConnectFour3D

def select_move(policy, temperature=1.0, play_best_move=False):
    """
    Selects a move based on the policy distribution.
    
    Args:
        policy (np.ndarray): The probability distribution over actions.
        temperature (float): Controls the level of exploration. Higher temp = more random.
        play_best_move (bool): If True, deterministically selects the best move.
    
    Returns:
        int: The selected action.
    """
    if play_best_move:
        return np.argmax(policy)

    if temperature <= 0:
        raise ValueError("Temperature must be greater than 0 for stochastic selection.")
    
    # Adjust policy with temperature
    adjusted_policy = np.power(policy, 1 / temperature)
    adjusted_policy /= np.sum(adjusted_policy)
    
    # Randomly select a move based on the adjusted probabilities
    move = np.random.choice(len(policy), p=adjusted_policy)
    return move


class ResidualBlock3d(nn.Module):
    """
    A 3D residual block for the ResNet architecture.
    Each block consists of two 3D convolutional layers with batch normalization.
    """
    def __init__(self, num_hidden):
        super().__init__()
        self.conv1 = nn.Conv3d(num_hidden, num_hidden, kernel_size=3, padding=1)
        self.bn1 = nn.BatchNorm3d(num_hidden)
        self.conv2 = nn.Conv3d(num_hidden, num_hidden, kernel_size=3, padding=1)
        self.bn2 = nn.BatchNorm3d(num_hidden)

    def forward(self, x):
        residual = x
        out = self.conv1(x)
        out = self.bn1(out)
        out = F.relu(out)
        out = self.conv2(out)
        out = self.bn2(out)
        out += residual  # Skip connection
        out = F.relu(out)
        return out

class ResNet3D(nn.Module):
    """
    A full ResNet model for 3D Connect Four, outputting a policy and a value.
    This architecture is inspired by AlphaZero and optimized for GPU.
    """
    def __init__(self, game: ConnectFour3D, num_resBlocks: int, num_hidden: int, device):
        super().__init__()
        self.device = device
        
        # Initial convolutional block
        self.startBlock = nn.Sequential(
            nn.Conv3d(4, num_hidden, kernel_size=3, padding=1),
            nn.BatchNorm3d(num_hidden),
            nn.ReLU()
        )
        
        # Backbone of residual blocks
        self.backBone = nn.ModuleList(
            [ResidualBlock3d(num_hidden) for _ in range(num_resBlocks)]
        )
        
        # Policy head
        self.policyHead = nn.Sequential(
            nn.Conv3d(num_hidden, 32, kernel_size=3, padding=1),
            nn.BatchNorm3d(32),
            nn.ReLU(),
            nn.Flatten(),
            nn.Linear(32 * game.depth * game.rows * game.cols, game.num_actions)
        )
        
        # Value head
        self.valueHead = nn.Sequential(
            nn.Conv3d(num_hidden, 3, kernel_size=3, padding=1),
            nn.BatchNorm3d(3),
            nn.ReLU(),
            nn.Flatten(),
            nn.Linear(3 * game.depth * game.rows * game.cols, 1),
            nn.Tanh()
        )
        
        self.to(self.device)

    def forward(self, x):
        """
        Forward pass through the network.
        
        Args:
            x (torch.Tensor): Input tensor of shape (batch, 4, 4, 4, 4)
        
        Returns:
            A tuple of (policy_logits, value).
        """
        x = self.startBlock(x)
        for block in self.backBone:
            x = block(x)
        
        policy_logits = self.policyHead(x)
        value = self.valueHead(x)
        
        return policy_logits, value
    



    import math

class Node:
    """
    A node in the Monte Carlo Search Tree.
    """
    def __init__(self, game, args, state, parent=None, action_taken=None, prior=0):
        self.game = game
        self.args = args
        self.state = state
        self.parent = parent
        self.action_taken = action_taken
        self.prior = prior
        
        self.children = []
        
        self.visit_count = 0
        self.value_sum = 0
        
    def is_fully_expanded(self):
        return len(self.children) > 0

    def select(self):
        """Selects the best child node based on the UCB1 formula."""
        best_child = None
        best_ucb = -np.inf
        
        for child in self.children:
            ucb = self.get_ucb(child)
            if ucb > best_ucb:
                best_ucb = ucb
                best_child = child
                
        return best_child

    def get_ucb(self, child):
        """Calculates the Upper Confidence Bound for a child node."""
        # q_value is the child's average value from the parent's perspective.
        # A high value for the child is a low value for the parent.
        if child.visit_count == 0:
            q_value = 0
        else:
            q_value = -child.value_sum / child.visit_count

        ucb = q_value + self.args['C'] * \
            (child.prior * math.sqrt(self.visit_count) / (child.visit_count + 1))
        return ucb
    
    def expand(self, policy):
        """Expands the node by creating children for all valid moves."""
        for action, prob in enumerate(policy):
            if prob > 0:
                child_state = np.copy(self.state)
                child_state = self.game.get_next_state(child_state, action)
                
                child = Node(self.game, self.args, child_state, self, action, prob)
                self.children.append(child)

    def backpropagate(self, value):
        """Backpropagates the simulation result up the tree."""
        self.value_sum += value
        self.visit_count += 1
        
        value = -value # The parent's value is the inverse of the child's
        if self.parent is not None:
            self.parent.backpropagate(value)

class MCTS:
    """
    Monte Carlo Tree Search implementation for an AlphaZero-like agent.
    """
    def __init__(self, game, args, model):
        self.game = game
        self.args = args
        self.model = model

    @torch.no_grad()
    def search(self, state, add_exploration_noise=False):
        """
        Performs MCTS simulations to determine the best move.
        
        Args:
            state (np.ndarray): The current board state.
            
        Returns:
            A policy vector representing the probability distribution of moves.
        """
        root = Node(self.game, self.args, state)
        # --- ADD THIS BLOCK FOR EXPLORATION ---
        if add_exploration_noise:
            # Get policy for the root node to apply noise
            encoded_state = self.game.get_encoded_state(root.state)
            policy_logits, _ = self.model(
                torch.tensor(encoded_state, device=self.model.device).unsqueeze(0)
            )
            policy = torch.softmax(policy_logits, axis=1).squeeze(0).cpu().numpy()
            valid_moves = self.game.get_valid_moves(root.state)
            policy *= valid_moves # Mask invalid moves before adding noise
            
            # Add Dirichlet noise
            noise = np.random.dirichlet([self.args['dirichlet_alpha']] * self.game.num_actions)
            policy = (1 - self.args['dirichlet_epsilon']) * policy + self.args['dirichlet_epsilon'] * noise
            
            # --- FIX: Re-apply the mask after adding noise ---
            policy *= valid_moves
            
            # Re-normalize, checking for a sum of zero to avoid errors
            if np.sum(policy) > 0:
                policy /= np.sum(policy)
            
            # Expand the root with the correctly-masked noisy policy
            root.expand(policy)
        # ----------------------------------------

        for _ in range(self.args['num_simulations']):
            node = root
            
            # 1. Selection
            while node.is_fully_expanded():
                node = node.select()
                
            value, is_terminal = self.game.get_value_and_terminated(node.state)

            if not is_terminal:
                # 2. Expansion (only if the node hasn't been expanded, e.g., the root with noise)
                if not node.is_fully_expanded():
                    encoded_state = self.game.get_encoded_state(node.state)
                    policy_logits, value_tensor = self.model(
                        torch.tensor(encoded_state, device=self.model.device).unsqueeze(0)
                    )
                    policy = torch.softmax(policy_logits, axis=1).squeeze(0).cpu().numpy()
                    valid_moves = self.game.get_valid_moves(node.state)
                    policy *= valid_moves
                    
                    if np.sum(policy) > 0:
                        policy /= np.sum(policy)
                    else:
                        # Fallback for a garbage policy from the NN:
                        # This prevents the expansion from creating zero children.
                        policy = valid_moves / np.sum(valid_moves)
                    
                    node.expand(policy)
                    value = value_tensor.item()
                

            # 3. Backpropagation
            node.backpropagate(value)
            
        # Return action probabilities based on visit counts
        action_probs = np.zeros(self.game.num_actions)
        for child in root.children:
            action_probs[child.action_taken] = child.visit_count
        action_probs /= np.sum(action_probs)
        return action_probs