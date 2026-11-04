#!/usr/bin/env python3
"""Decode the benchmark pages once into raw RGBA for test/panels/eval.cjs.

    python3 test/panels/prepare.py EVAL_DIR [--device 480x800] [--full]

EVAL_DIR holds labels.json (see test/panels/README.md) and the page images under pages/. Each
page is written as cache/<id>_<w>x<h>.rgba at the size the converter would detect on: fitted
inside the device screen (a landscape page against the swapped box, never upscaled, as
manga-core.js:fitToDeviceSize does), and with --full also at its own resolution. Pillow's
Lanczos stands in for the browser canvas's high-quality downscale.

Images are checked against the sha256 recorded in labels.json, so a label set is never scored
against a different scan of the same page.
"""
import argparse
import hashlib
import json
import os
import sys

from PIL import Image


def fit(w, h, target):
    tw, th = target
    if w > h:
        tw, th = th, tw
    scale = min(tw / w, th / h)
    if scale >= 1.0:
        return w, h
    return min(tw, max(1, round(w * scale))), min(th, max(1, round(h * scale)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("eval_dir")
    ap.add_argument("--device", default="480x800", help="screen WxH; 'none' to skip")
    ap.add_argument("--full", action="store_true", help="also write each page at full resolution")
    args = ap.parse_args()

    labels = json.load(open(os.path.join(args.eval_dir, "labels.json"), encoding="utf-8"))
    cache = os.path.join(args.eval_dir, "cache")
    os.makedirs(cache, exist_ok=True)
    targets = []
    if args.device != "none":
        targets.append(tuple(int(v) for v in args.device.lower().split("x")))
    bad = 0
    for page in labels["pages"]:
        path = os.path.join(args.eval_dir, "pages", page["file"])
        data = open(path, "rb").read()
        if page.get("sha256") and hashlib.sha256(data).hexdigest() != page["sha256"]:
            print(f"{page['id']}: {page['file']} does not match its recorded sha256", file=sys.stderr)
            bad += 1
            continue
        img = Image.open(path).convert("RGB")
        sizes = [fit(img.width, img.height, t) for t in targets]
        if args.full:
            sizes.append((img.width, img.height))
        for w, h in dict.fromkeys(sizes):
            out = os.path.join(cache, f"{page['id']}_{w}x{h}.rgba")
            if os.path.exists(out):
                continue
            im = img if (w, h) == img.size else img.resize((w, h), Image.LANCZOS)
            with open(out, "wb") as f:
                f.write(im.convert("RGBA").tobytes())
    print(f"{len(labels['pages']) - bad} page(s) ready in {cache}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
