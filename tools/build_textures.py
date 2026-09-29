"""textures/ (4k, ~40 MB) -> public/static/textures/ (512px, ~250 KB). Requires Pillow.

    python tools/build_textures.py
"""
import os

from PIL import Image, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, os.pardir, 'textures')
DST = os.path.join(HERE, os.pardir, 'public', 'static', 'textures')
SIZE = 512

# A tint can only darken its map and the clay albedo is mid brown, so the clay albedo is
# remapped to a narrow band just below white; the oak albedo is only downscaled.
PALE_BASE = 0.90        # mean output level, 0..1
PALE_AMP = 0.055        # how far one standard deviation of the source moves it


def _resize(src_name):
    return Image.open(os.path.join(SRC, src_name)).convert('RGB') \
                .resize((SIZE, SIZE), Image.LANCZOS)


def _save(image, dst_name, quality):
    dst = os.path.join(DST, dst_name)
    image.save(dst, 'JPEG', quality=quality, optimize=True)
    mean = tuple(round(c) for c in ImageStat.Stat(image.convert('RGB')).mean)
    print(f'{dst_name:32s} {os.path.getsize(dst) / 1024:6.0f} KB  mean rgb={mean}')


def shrink(src_name, dst_name, quality=88):
    _save(_resize(src_name), dst_name, quality)


def shrink_pale(src_name, dst_name, quality=90):
    """Downscale, then remap luminance onto PALE_BASE +/- a few percent."""
    image = _resize(src_name).convert('L')
    stat = ImageStat.Stat(image)
    # out = BASE + AMP * z-score, written as a linear point transform on the 0..255 input.
    scale = (PALE_AMP * 255.0) / max(stat.stddev[0], 1e-6)
    offset = PALE_BASE * 255.0 - scale * stat.mean[0]
    _save(image.point(lambda v: v * scale + offset).convert('RGB'), dst_name, quality)


def main():
    os.makedirs(DST, exist_ok=True)
    shrink_pale('clay_floor_001_diff_4k.jpg', 'clay_floor_001_diff_pale.jpg')
    shrink('clay_floor_001_nor_gl_4k.jpg', 'clay_floor_001_nor_gl.jpg', quality=92)
    shrink('clay_floor_001_rough_4k.jpg', 'clay_floor_001_rough.jpg')
    shrink('oak_veneer_01_diff_4k.jpg', 'oak_veneer_01_diff.jpg')
    shrink('oak_veneer_01_arm_4k.jpg', 'oak_veneer_01_arm.jpg', quality=90)


if __name__ == '__main__':
    main()
