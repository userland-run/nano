#!/usr/bin/env python3
# Regenerate exifstrip test fixtures (needs Pillow; HEIC via macOS `sips`).
# Small synthetic images carrying EXIF (camera, date, orientation, GPS), XMP,
# an ICC profile and comments/text chunks.
import io, os, subprocess, sys
from PIL import Image, ImageCms
from PIL.PngImagePlugin import PngInfo

here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
os.makedirs(here, exist_ok=True)

img = Image.new("RGB", (64, 48))
img.putdata([((x * 4) % 256, (y * 5) % 256, ((x + y) * 3) % 256) for y in range(48) for x in range(64)])

exif = Image.Exif()
exif[0x010F] = "Canon"
exif[0x0110] = "Canon EOS 5D Mark IV"
exif[0x0112] = 6
exif[0x0132] = "2024:05:01 12:34:56"
exif.get_ifd(0x8769)[0x9003] = "2024:05:01 12:34:56"
gps = exif.get_ifd(0x8825)
gps[1] = "N"; gps[2] = (47.0, 16.0, 9.12)
gps[3] = "E"; gps[4] = (11.0, 24.0, 14.76)
exif_bytes = exif.tobytes()
xmp = b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Jane Photographer"/></rdf:RDF></x:xmpmeta>'
icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()

def path(n): return os.path.join(here, n)

# JPEG: EXIF + XMP + ICC + COM
buf = io.BytesIO()
img.save(buf, "JPEG", quality=85, exif=exif_bytes, icc_profile=icc, xmp=xmp, comment=b"shot at the lake")
open(path("photo.jpg"), "wb").write(buf.getvalue())

# PNG: eXIf + iTXt XMP + tEXt + iCCP
info = PngInfo()
info.add_text("Comment", "shot at the lake")
info.add_itxt("XML:com.adobe.xmp", xmp.decode())
img.save(path("photo.png"), "PNG", exif=exif_bytes, icc_profile=icc, pnginfo=info)

# WebP (lossless, so the VP8L payload is deterministic): EXIF + XMP + ICCP
img.save(path("photo.webp"), "WEBP", lossless=True, exif=exif_bytes, xmp=xmp, icc_profile=icc)

# Clean PNG (no metadata at all)
img.save(path("clean.png"), "PNG")

# HEIC via sips (macOS); keeps the EXIF from the JPEG
if sys.platform == "darwin":
    subprocess.run(["sips", "-s", "format", "heic", path("photo.jpg"), "--out", path("photo.heic")], check=True, stdout=subprocess.DEVNULL)
