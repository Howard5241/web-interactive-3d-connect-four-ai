"""models/model_best.pth -> static/nn/model.onnx for the browser AI. Requires torch and onnx.

    python tools/export_onnx.py
"""
import os
import re
import sys

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, os.pardir))
sys.path.insert(0, ROOT)

from ai_agent import ResNet3D  # noqa: E402
from game_logic import ConnectFour3D  # noqa: E402

SRC = os.path.join(ROOT, 'models', 'model_best.pth')
DST = os.path.join(ROOT, 'static', 'nn', 'model.onnx')


def load_state_dict(path):
    state_dict = torch.load(path, map_location='cpu')
    if 'startBlock.0.weight' not in state_dict:
        for key in ('state_dict', 'model_state_dict', 'model'):
            if isinstance(state_dict.get(key), dict):
                return state_dict[key]
    return state_dict


def main():
    state_dict = load_state_dict(SRC)
    num_hidden = state_dict['startBlock.0.weight'].shape[0]
    blocks = {int(m.group(1)) for k in state_dict if (m := re.match(r'backBone\.(\d+)\.', k))}
    num_blocks = max(blocks) + 1 if blocks else 0

    model = ResNet3D(ConnectFour3D(), num_blocks, num_hidden, 'cpu')
    model.load_state_dict(state_dict)
    model.eval()

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    board = torch.zeros(1, 4, 4, 4, 4)
    torch.onnx.export(model, board, DST, input_names=['board'], output_names=['policy', 'value'],
                      opset_version=17, dynamo=False)
    print(f'{num_blocks} blocks x {num_hidden} channels -> {DST} '
          f'({os.path.getsize(DST) / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
