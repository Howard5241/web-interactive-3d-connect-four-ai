"""Build the web-sized piece textures in static/textures/ from the 4k sources in textures/.

The light pieces are glazed clay (clay_floor_001), the dark ones oak veneer
(oak_veneer_01). The sources are 4k and total ~40 MB, which is absurd for beads a few
dozen pixels across, so every map is resampled to 512 and re-encoded -- the whole set
comes to ~250 KB.

Run it after replacing a source map:

    python tools/build_textures.py

Requires Pillow. The generated files are committed, so this is only needed when the
sources or the settings below change.
"""
import os

from PIL import Image, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, os.pardir, 'textures')
DST = os.path.join(HERE, os.pardir, 'static', 'textures')
SIZE = 512

# The light pieces have to read as white. A material's colour can only ever *darken* its
# albedo map -- the shader multiplies the two -- and clay_floor's albedo is a mid brown, so
# no tint over a faithful downscale will ever produce a white piece. The clay albedo is
# therefore remapped onto a narrow band of luminance just below white: the streaks, cracks
# and trowel marks all survive as gentle shading, and the actual relief still comes from
# the untouched normal and roughness maps.
#
# The oak albedo needs no such treatment: the dark pieces are darker than it is, and
# darkening is what a tint does.
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
