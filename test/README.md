# Tests

Two suites, plus a script that builds everything they compare against, and a
[panel-detection benchmark](#panel-detection-benchmark) scored against hand-labelled pages.

Most of what these tests assert is **byte equality with the firmware's own Python
tools**. `js/` is a browser port of `tools/manga_convert/convert_manga.py` and
`tools/dict_convert/convert_jmdict.py` from the
[matcha-reader](https://github.com/eszter007/matcha-reader) repo, and the device reads
whatever they produce — so "the JS output is identical to the Python output" is the
property worth protecting, not "the JS output looks reasonable".

That means the reference outputs must be generated **from a checkout of the firmware
repo** before either suite is fully meaningful. Without it both suites still run, but
every comparison against a reference skips.

## Setup

```sh
# 1. The firmware repo, as a sibling of this one (or set MATCHA_READER below)
git clone https://github.com/eszter007/matcha-reader ../matcha-reader

# 2. Python packages for fixture + reference generation
pip install -r test/requirements.txt

# 3. Node packages for the browser suite
npm install playwright onnxruntime-web
npx playwright install chromium

# 4. Build the fixtures and references (writes into test/fixtures/, gitignored)
MATCHA_READER=../matcha-reader python3 test/gen_references.py
```

`MATCHA_READER` defaults to `../matcha-reader` relative to the repo root, so step 1
above needs no environment variable. Set it if the firmware lives elsewhere.

`gen_references.py` prints `SKIPPED (...)` for anything it cannot build and carries on.
A partial install is fine — you just get fewer comparisons.

## Running

```sh
node test/node/run.cjs        # pure functions vs the Python tools
node test/browser/e2e.mjs     # the real pages, driven in Chromium
```

Both print `ok` / `FAIL` per check and exit non-zero on failure.

### On macOS

The suite was written against Linux paths. Two variables point it elsewhere, for both
`gen_references.py` and `e2e.mjs`:

```sh
export TEST_FONT=../matcha-reader/freeink-sdk/libs/book/FreeInkBook/test/fixtures/fonts/DejaVuSans.ttf
export CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"  # or `npx playwright install chromium`
```

The browser is launched with GPU canvas off, so the no-`OffscreenCanvas` comparison is
byte-exact on desktop browsers too (a GPU-rasterised `<canvas>` scales images a few grey
levels differently from `OffscreenCanvas`).

`cpfont structural comparison` is skipped on macOS: `fonts.html` rasterises glyphs with the
browser's font engine, which is CoreText there rather than FreeType, and bitmap metrics land
3px from `fontconvert_sdcard.py` against the 2px the check allows. It runs on Linux.

The node suite needs **no npm packages at all** (the YOLO comparison skips without
`onnxruntime-web`). The browser suite needs `playwright`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MATCHA_READER` | `../matcha-reader` | Firmware checkout, for `gen_references.py` |
| `TEST_FONT` | `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` | Font converted by the `fonts.html` test |
| `CHROMIUM_PATH` | Playwright's managed browser | Override for environments shipping Chromium elsewhere |

Non-ASCII download filenames need a UTF-8 locale. Under a bare `POSIX` locale Chromium
falls back to naming every download `download`, which fails the tests that check output
filenames — export `LANG=C.UTF-8` if you hit that.

## What each suite covers

**`test/node/run.cjs`** — the pure conversion logic in `js/`, with no browser:
panel detection and reading-order sort, the manga binary formats
(`panels.idx`/`panels.dat`/`meta.bin`/`toc.idx`), XTC/XTCH encoding decoded back the way
the firmware's reader does, 1-bit BMP output, device downscaling, EPUB assembly, the
dictionary converters and their POS flags (Japanese, Chinese and Cantonese), pinyin and
furigana (dictionary and AI paths, the AI fed fixed answers), and the zip writer.

**`test/browser/e2e.mjs`** — the actual pages in Chromium, end to end: a file goes into
the picker, the download that comes out is unzipped and compared. Covers `manga.html`
(CBZ, EPUB, PDF and chapter-foldered input; grid and AI panel detection; panels-only;
XTC/XTCH; the Gemini OCR path with the API stubbed, so it needs no key and no network;
and the no-`OffscreenCanvas` fallback older Safari takes), `dictionary.html`
(Yomitan, MDict, Chinese and Cantonese), `ruby.html` (pinyin from the dictionary, pinyin and
furigana with Gemini stubbed to the reference answers), and `fonts.html`.

## Fixtures

`test/fixtures/` is gitignored and entirely generated. Delete it and re-run
`gen_references.py` at any time.

| Fixture | Built by | Used for |
| --- | --- | --- |
| `manga_pages/`, `manga.cbz` | synthetic | the main conversion comparisons |
| `manga.epub`, `manga.pdf` | synthetic | EPUB spine order, PDF rasterisation |
| `manga_fullbleed.cbz` | synthetic | panels-only on borderless pages |
| `manga_foldered.cbz` | synthetic | page order through chapter subfolders |
| `ref_manga*/`, `ref_dict_*/` | `convert_manga.py`, `convert_jmdict.py` | byte comparison |
| `zh/`, `ref_dict_zh*/`, `ref_dict_yue/` | synthetic, `convert_jmdict.py --lang zh/yue` | the Chinese paths, every option at once |
| `zh/book.epub`, `ref_pinyin/` | synthetic, `add_pinyin_ruby.py` | pinyin from the dictionary, XHTML comparison |
| `zh/ai_*.xhtml`, `zh/ai_*_answers.json`, `ref_ruby_ai/` | synthetic, `add_pinyin_ruby.py` / `add_furigana_ruby.py` with the answers file standing in for Gemini | AI pinyin and furigana, XHTML comparison; some answers are wrong on purpose |
| `ref_yolo/boxes.json` | the shipped ONNX model, decoded by a numpy port of `js/yolo.js` | panel boxes, ±2px |
| `ref_font/` | the firmware's `fontconvert_sdcard.py` | `.cpfont` structure |

## Panel-detection benchmark

`test/panels/` measures how well a detector finds panels on real manga pages, against boxes a
person drew. It is not part of either suite: the pages are copyrighted scans, so neither they
nor their labels are in the repo, only the harness and the label format.

```sh
python3 test/panels/prepare.py EVAL_DIR --full      # once: decode the pages to raw RGBA
node test/panels/eval.cjs EVAL_DIR                  # score grid + shipped at 480x800
node test/panels/eval.cjs EVAL_DIR --size full --variants shipped --json out.json
```

`EVAL_DIR` holds `labels.json` and the images under `pages/`. Pages are scored at the size the
converter detects on: fitted inside the device screen (`--device`, default 480x800 for the X4
and X4 Pro), or at full resolution. ONNX Runtime runs single-threaded by default, as it does on
GitHub Pages, which is not cross-origin isolated, so the times are what a browser sees.
`--extra FILE.cjs` adds detector variants (the shape is described in `variants.cjs`).

What it reports (`metrics.cjs`, unit-tested in the Node suite):

- precision, recall and F1 at IoU 0.5 and at 0.75: greedy one-to-one matching, best IoU first,
  micro-averaged over all panels;
- **exact**: the share of pages with the right number of panels, each matched at IoU >= 0.75;
- **order**: on pages where every panel was found (IoU >= 0.5, two or more panels), the share
  whose panels come out of `sortPanelsReadingOrder()` in the labelled reading order;
- mean IoU of the matched panels, milliseconds per page, and the model download.

### Label format

```json
{"format": "matcha-panels-gt/1",
 "pages": [{"id": "p07", "file": "p07.jpg", "width": 1070, "height": 1600,
            "sha256": "…", "source": {"zip": "…", "entry": "…"},
            "layout": "rtl", "tags": ["slanted", "bleed"],
            "panels": [{"box": [x1, y1, x2, y2]}, {"box": [x1, y1, x2, y2], "ignore": true}],
            "notes": "…"}]}
```

Boxes are in the original image's pixels and `panels` is in reading order. `layout` is `rtl`,
`ltr`, `yonkoma-rtl` or `yonkoma-ltr` (a page of 4-koma strips read column by column) and sets
the sort the harness applies. A panel marked `ignore` is one the labeller could not call either
way: a detection on it is neither a hit nor a false positive. `prepare.py` refuses an image whose
sha256 differs from the label's.

### How the labels were made

The set behind the numbers in the main README is 55 pages from 37 series (one volume each) in
one reader's mokuro library, chosen by eye from 160 random pages to cover dense action pages,
4-koma, splash and chapter-title pages, colour pages, borderless and bleeding panels, slanted
and overlapping panels, black gutters, bubbles crossing borders and one two-page spread (248
panels, 2 ignored). None of it is Manga109, which every candidate model was trained on.

Four detectors proposed boxes for each page (RT-DETRv4-X, the YOLO26s now shipped, YOLO11m and
the old YOLO26n), averaged where two or more agreed; the labeller saw them as hints only.
Every page was then labelled by looking at it plain, with the proposals, and with the labels
drawn over it on a pixel grid, zooming in on doubtful edges. The rules:

- a panel is artwork inside a drawn frame, or, without a frame, art separated from its
  neighbours by a gutter or their frames;
- the box is the outer edge of the frame line; art that bleeds off the page goes to the image
  edge; bubbles, captions and sound effects overhanging the frame are not part of it;
- slanted or jagged panels get their bounding rectangle; an inset is its own panel and the panel
  under it keeps its full rectangle; a splash page is one panel;
- page numbers, margin titles and credits are not panels;
- reading order is tiers top to bottom, right to left within a tier, with a tall right-hand panel
  read before the stack beside it; 4-koma strips are read column by column.

A snapping tool moved edges onto the nearest frame line, and every move was checked. It often
latched onto a neighbour's frame, a black gutter or a balloon outline, so many edges were set by
hand from pixel profiles instead. The labelling was done by Claude (an AI model) in four batches,
and all 55 pages were then reviewed together on contact sheets. Two pages hold an `ignore` box
(a framed chapter-title card, and the backdrop a page's panels sit on).

Caveats: 55 pages is small (one page is 1.8 points of "exact"); the labels are judgement
calls on borderless and overlapping panels; the proposals shown while labelling came partly from
models being compared, which can favour them where a judgement call went their way; and the
thresholds were tuned on the even-numbered half, so the odd half is the cleaner test.

## Adding a test

Keep the byte-comparison property intact. If a change makes the JS diverge from the
Python tools on any input the fixtures cover, that is a bug in one of them — fix both
together rather than loosening the assertion. Where the two deliberately agree on
something surprising (XML entity decoding is limited to the five predefined entities
plus numeric references, for instance, because `html.unescape` would decode more), the
test says so and why, so the reasoning survives the next person to look at it.
