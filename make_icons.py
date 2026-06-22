from pathlib import Path

from PIL import Image, ImageDraw


out = Path(__file__).with_name("icons")
out.mkdir(parents=True, exist_ok=True)

for size in (192, 512):
    img = Image.new("RGB", (size, size), "#2f7d5c")
    d = ImageDraw.Draw(img)
    pad = int(size * 0.12)
    d.rounded_rectangle((pad, pad, size - pad, size - pad), radius=int(size * 0.18), fill="#fffdf7")

    cx, cy = size // 2, int(size * 0.48)
    plate_r = int(size * 0.22)
    d.ellipse(
        (cx - plate_r, cy - plate_r, cx + plate_r, cy + plate_r),
        fill="#edf4ef",
        outline="#2f7d5c",
        width=max(4, size // 42),
    )
    d.arc(
        (
            cx - plate_r + int(size * 0.05),
            cy - plate_r + int(size * 0.05),
            cx + plate_r - int(size * 0.05),
            cy + plate_r - int(size * 0.05),
        ),
        205,
        335,
        fill="#d66b4a",
        width=max(5, size // 35),
    )
    d.line(
        (
            int(size * 0.31),
            int(size * 0.68),
            int(size * 0.44),
            int(size * 0.60),
            int(size * 0.56),
            int(size * 0.64),
            int(size * 0.70),
            int(size * 0.52),
        ),
        fill="#c59c43",
        width=max(7, size // 28),
        joint="curve",
    )
    d.ellipse((int(size * 0.66), int(size * 0.48), int(size * 0.75), int(size * 0.57)), fill="#d66b4a")
    d.rounded_rectangle(
        (int(size * 0.30), int(size * 0.76), int(size * 0.70), int(size * 0.84)),
        radius=int(size * 0.04),
        fill="#2f7d5c",
    )
    d.rectangle((int(size * 0.30), int(size * 0.76), int(size * 0.49), int(size * 0.84)), fill="#1f5f46")
    img.save(out / f"icon-{size}.png")
