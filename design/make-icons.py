#!/usr/bin/env python3
"""
Generate the extension's toolbar icons from the Executor mark.

Two problems this replaces.

The old icon was not the Executor logo at all, a blue circle around a green
rectangle, drawn in Chrome's own palette. It looked like a browser utility
someone shipped in an afternoon, and it shared no identity with the product it
connects to.

The old status was a text badge: "ON", "!", "USE" in Google red/green/amber,
which Chrome paints as a rounded rectangle across the bottom of a 16px icon.
At that size the badge is most of the icon, so the logo was hidden precisely
whenever the extension had something to say. Status now lives in a small dot in
the lower-right of the disc, a region the glyph does not occupy, and the badge
text is left empty. The mark stays legible in every state.

Source of truth is design/source/executor-mark.png, copied verbatim from
apps/marketing/public/favicon-192.png in the Executor repo. The glyph is never
redrawn here, only recentred and composited, so the extension cannot drift away
from the product's mark.

Run:  python design/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "design" / "source" / "executor-mark.png"
OUT = ROOT / "extension" / "icons"

# Chrome renders the action icon at 16 and 48; 128 is for the extensions page
# and the Web Store listing.
SIZES = (16, 48, 128)

# Supersample, then downscale with LANCZOS. A 16px disc drawn directly has a
# visibly polygonal edge.
SS = 16

# The disc fills all but a hair of the canvas. An inset disc read as a small,
# timid icon next to neighbours that fill their box, next to other extensions
# in the toolbar it looked like it had been shrunk by mistake.
DISC_SCALE = 0.98

# The glyph, enlarged within the disc.
#
# The published favicon is a web favicon: the E occupies barely half the disc's
# height, which is elegant at 192px and unreadable at 16. Scaling the glyph up
# inside its own disc keeps the mark's construction, same letterform, same
# colours, same circle, while giving it the presence a toolbar icon needs.
GLYPH_SCALE = 1.30

# Lower-right, mostly outside the disc: the avatar-presence position. Every
# value below is checked against the glyph bounds by check_geometry().
DOT_CENTRE = 0.83
DOT_RADIUS = 0.125
# Transparent moat, so the dot reads as an indicator sitting beside the mark
# rather than as part of it.
DOT_GAP = 0.04

# Where the cream glyph ends, as a fraction of the disc's own box. Measured
# from the source mark (glyph bbox 62-113 x 45-137 of a 1-179 x 4-182 disc).
GLYPH_MAX_X = 0.59
GLYPH_MAX_Y = 0.71

# Minimum daylight between the moat and the glyph.
CLEARANCE = 0.015

STATUS_COLOURS = {
    # Not set up yet. Deliberately not red: a fresh install has done nothing
    # wrong, and an error colour on first run trains people to ignore it.
    "off": (113, 113, 122, 255),
    # Configured, but the control channel is not up, this one has gone wrong.
    "error": (239, 68, 68, 255),
    # Agents can drive this browser. Matches --live in sidebar.css.
    "live": (16, 185, 129, 255),
    # An agent is acting right now. Matches --amber in sidebar.css.
    "active": (245, 158, 11, 255),
}


def normalised_mark(size: int) -> Image.Image:
    """The mark, recentred and inset on a square canvas of `size`.

    The published favicon sits a pixel or two off-centre in its own canvas,
    which is invisible at 192px and obvious at 16.
    """
    mark = Image.open(SOURCE).convert("RGBA")
    disc = mark.crop(mark.getbbox())
    side = max(disc.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(disc, ((side - disc.width) // 2, (side - disc.height) // 2))

    inner = max(1, round(size * DISC_SCALE))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - inner) // 2
    canvas.paste(square.resize((inner, inner), Image.LANCZOS), (offset, offset))
    return canvas


def glyph_mask(canvas: Image.Image) -> Image.Image:
    """The cream letterform, as a mask. Everything else on the disc is black."""
    red = canvas.split()[0]
    return Image.eval(red, lambda v: 255 if v > 128 else 0)


def enlarge_glyph(canvas: Image.Image, scale: float) -> Image.Image:
    """Grow the letterform inside its disc, about the disc's centre.

    The disc is left exactly as published; only the glyph is scaled, so the
    result is still the Executor mark rather than a redrawing of it.
    """
    if scale == 1.0:
        return canvas
    size = canvas.size[0]
    mask = glyph_mask(canvas)

    # The disc with the glyph painted out, so the enlarged one lands on plain
    # black instead of a halo of the original.
    disc = canvas.copy()
    disc.paste(Image.new("RGBA", canvas.size, (0, 0, 0, 255)), (0, 0), mask)

    grown_side = max(1, round(size * scale))
    grown = mask.resize((grown_side, grown_side), Image.LANCZOS)
    offset = (size - grown_side) // 2

    cream = Image.new("RGBA", canvas.size, (243, 239, 231, 255))
    placed = Image.new("L", canvas.size, 0)
    placed.paste(grown, (offset, offset))
    # Never let the glyph spill past the disc's own edge.
    placed = Image.composite(placed, Image.new("L", canvas.size, 0), canvas.split()[3])

    out = disc
    out.paste(cream, (0, 0), placed)
    return out


def embolden_glyph(canvas: Image.Image, radius: int) -> Image.Image:
    """Thicken the cream glyph before downscaling.

    The mark is a serif form, and serif hairlines do not survive a trip to
    16px, they thin to a few percent of alpha and the letter reads as a smudge.
    Dilating the glyph slightly at supersample scale keeps the shape while
    giving the thin strokes enough weight to land on a real pixel. Applied only
    at the sizes that need it, so the 48 and 128 renders stay exactly the
    published mark.
    """
    r, g, b, a = canvas.split()
    # The glyph is the light-on-black part of the disc.
    glyph = Image.eval(r, lambda v: 255 if v > 128 else 0)
    grown = glyph.filter(ImageFilter.MaxFilter(radius * 2 + 1))
    cream = Image.new("RGBA", canvas.size, (243, 239, 231, 255))
    out = canvas.copy()
    out.paste(cream, (0, 0), grown)
    return out


def with_status(size: int, colour: tuple[int, int, int, int] | None) -> Image.Image:
    canvas = enlarge_glyph(normalised_mark(size * SS), GLYPH_SCALE)
    if size <= 16:
        canvas = embolden_glyph(canvas, radius=max(1, round(size * SS * 0.012)))
    if colour is not None:
        draw = ImageDraw.Draw(canvas)
        big = size * SS
        cx = cy = DOT_CENTRE * big
        outer = (DOT_RADIUS + DOT_GAP) * big
        inner = DOT_RADIUS * big
        # Punch the moat out of the disc first, then fill the dot into it.
        draw.ellipse([cx - outer, cy - outer, cx + outer, cy + outer], fill=(0, 0, 0, 0))
        draw.ellipse([cx - inner, cy - inner, cx + inner, cy + inner], fill=colour)
    return canvas.resize((size, size), Image.LANCZOS)


def check_geometry() -> None:
    """Fail loudly if the status dot would touch the glyph.

    The first pass of this design put the dot on the centre diagonal, where its
    moat took a bite out of the E's lower serif at 16px, visible only after
    magnifying the output. The constants above are easy to nudge, so the
    clearance is asserted rather than eyeballed.
    """
    # Glyph bounds, mapped from the disc's own box onto the inset canvas.
    glyph_x = 0.5 + (GLYPH_MAX_X - 0.5) * GLYPH_SCALE * DISC_SCALE
    glyph_y = 0.5 + (GLYPH_MAX_Y - 0.5) * GLYPH_SCALE * DISC_SCALE
    moat = DOT_RADIUS + DOT_GAP

    # Nearest point of the moat circle to the glyph's bottom-right corner.
    dx = glyph_x - DOT_CENTRE
    dy = glyph_y - DOT_CENTRE
    distance = (dx * dx + dy * dy) ** 0.5
    # A hair of slack, so a value that only just clears does not read as fine.
    if distance < moat + CLEARANCE:
        raise SystemExit(
            f"status dot overlaps the glyph: corner is {distance:.3f} from the dot "
            f"centre but the moat reaches {moat:.3f}. Move DOT_CENTRE out, or "
            f"shrink DOT_RADIUS/DOT_GAP."
        )
    if DOT_CENTRE + moat > 1.0:
        raise SystemExit("status dot runs off the canvas; reduce DOT_CENTRE or DOT_RADIUS")


def main() -> None:
    check_geometry()
    OUT.mkdir(parents=True, exist_ok=True)
    written = []

    for size in SIZES:
        path = OUT / f"icon{size}.png"
        with_status(size, None).save(path)
        written.append(path)

    # Only the toolbar sizes need status variants.
    for state, colour in STATUS_COLOURS.items():
        for size in (16, 48):
            path = OUT / f"icon{size}-{state}.png"
            with_status(size, colour).save(path)
            written.append(path)

    for path in written:
        print(f"wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
