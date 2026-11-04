# 🍵 Matcha Reader Tools

[![Discord](https://img.shields.io/discord/754001738184392704?logo=discord&label=Discord)](https://discord.skerritt.blog)

> bee-san's fork. It adds **mokuro volumes** as a manga input (choose a mokuro series `.zip` or a
> folder, pick a volume) and a choice of who reads the text: mokuro's own, **PP-OCR manga** in the
> browser, **Screen AI** (Chrome's on-device OCR) through a local helper, or Gemini.
> Live at <https://bee-san.github.io/matcha-reader-tools/>.

Browser-based converters for the [Matcha Reader](https://github.com/eszter007/matcha-reader)
e-reader firmware, a CrossPoint Reader fork with Japanese and Chinese learning features. Everything runs
client-side: **no installs, no uploads**. Files never leave your device, except panel images sent
to Gemini when you supply your own API key, and a book's text when you choose AI furigana or pinyin.

**Four tools:**

| Tool | Input | Output |
|---|---|---|
| 📖 **Manga Converter** | CBZ / ZIP / EPUB / PDF / page images | One `.matcha` file (firmware 2.0.0-rc-4 and up; a plain stored ZIP, rename to `.zip` to unpack) or the legacy manga folder: renamed pages, panel crops, `panels.idx`/`panels.dat` (with OCR text + translations), `meta.bin`, `toc.idx` — and/or a portable `.epub`, `.pdf`, `.xtc` or `.xtch` |
| 📚 **Dictionary Converter** | Chinese and Cantonese: nothing — pick the simplified, traditional or Cantonese edition, built from sources served with the page. Or your own files — Japanese: Yomitan `.zip` (Jitendex, JMnedict, grammar), jmdict-simplified `.json`/`.json.tgz`, MDict `.mdx`. Chinese and Cantonese: CC-CEDICT / CC-Canto text, the MoE `dict-revised.json`, Yomitan, MDict, a `headword<TAB>definition` TSV, with optional frequency, level, example-sentence and jyutping lists | `dict/<name>.idx` + `.dat` + `.spx` for Japanese; `dictionaries/zh/` or `dictionaries/yue/` with `vocab.*`, `names.*` and `.title` files for Chinese |
| 🔤 **Font Converter** | TTF / OTF (up to 4 styles + fallback font) | `.fonts/<Family>/<Family>_<size>.cpfont` (v4, with kerning + ligatures) |
| 🈷 **Furigana & Pinyin** | A Japanese or Chinese EPUB (+ optionally your own CC-CEDICT and a frequency list) | The same EPUB with furigana, or pinyin / zhuyin, as `<ruby>` over the text |

Each tool downloads a zip already laid out for the SD card: unzip it onto the card, or upload the
files via the reader's built-in Wi-Fi web file transfer.

## Choosing the text recognition

Step 4 of the manga converter picks what reads the speech bubbles. PP-OCR is the default, mokuro
volumes included: it was the most accurate, and needs no key or helper. Every choice but Gemini keeps the
pages on your computer, and all of them give each printed line its position, so word lookup on the
device lands on the right word (mokuro only when its file has line positions).

| Choice | Runs | Notes |
|---|---|---|
| **mokuro's own text** | already in a mokuro volume | Instant. manga-ocr confuses small kana; older volumes have no line positions. |
| **PP-OCR manga, in this browser** (default) | ONNX Runtime Web (WASM) | 12 MB downloaded once, about 2–3 s a page. Japanese and Chinese. |
| **Screen AI on this computer** | local helper, see below | Fast; reads small kana well, sometimes slips on `!?`. |
| **Gemini** | Google, with your API key | Also translates each panel. |
| **Skip** | — | Panels only, no lookup. |

On two Azumanga Daiou pages checked by hand, PP-OCR got the punctuation and small kana right where
the others slipped (`寝てばっかいただろー!?`, `おさんぽ`, `なぁー`).

## PP-OCR manga

[PP-OCRv6_manga](https://huggingface.co/Kellenok/PP-OCRv6_manga) by Kellenok (Apache-2.0): PaddleOCR's
PP-OCRv6 detector and recogniser fine-tuned on manga, vendored in `models/ppocr/` (FP16 ONNX, 0.9 MB +
10.6 MB) and run by `js/ppocr.js` with the same ONNX Runtime Web as panel detection. The pipeline follows
the model card's reference: detector input with the long side at 960, DB post-processing
(threshold 0.15, box threshold 0.25, unclip 1.4), each line cropped, vertical lines turned, resized to
48 px high and CTC-decoded. Manga lettering is axis-aligned, so connected regions and their bounding
boxes stand in for OpenCV's contours and rotated rectangles. Lines are then grouped into speech
bubbles, with furigana, page numbers and stray marks dropped.

## Screen AI text recognition

Step 4 of the manga converter offers **Screen AI on this computer**: the OCR Chrome ships for
accessibility, which reads vertical Japanese, small kana included, and gives every printed line its
box, so word lookup on the device lands on the right word. A web page cannot load it, so it runs in
a small helper from the Matcha Reader firmware repo:

```sh
python3 tools/manga_convert/screenai.py --serve
```

The first start downloads Chromium's own `screen-ai` package (checked against its published
SHA-256). The helper listens on `127.0.0.1:7393` only and answers this site and local pages; each page
goes to it and nowhere else. It regroups Screen AI's lines into speech bubbles and drops furigana,
page numbers and stray marks. Browsers may ask once whether this page may reach apps on your
device: allow it. There are no translations on this path; pick Gemini for those.

## Mokuro volumes

[mokuro](https://github.com/kha-white/mokuro) 0.2 and later writes a `<volume>.mokuro` file next to
each volume's folder of pages. The file holds every speech bubble's text and the box of each printed
line, which is what the device needs for word lookup. So a mokuro volume skips Gemini: no key, no
calls, and nothing leaves the browser.

- **A series archive** (`.zip` or `.cbz` with one or more volumes in it): choose the file, then pick
  the volume in the list that appears. Only the archive's directory and that volume's files are read,
  so multi-gigabyte series archives work (Zip64 included). An archive that never finished
  downloading is reported as soon as it is chosen.
- **A folder**: use *Or choose a folder of mokuro volumes* on the series folder, then pick the volume.

Step 4 reads the pages again with PP-OCR by default. **mokuro's own text** is offered too: instant,
but mokuro's reader (manga-ocr) confuses small kana (ぼ for ぽ, あ for ぁ), and volumes made with older
mokuro versions carry no line positions, which leaves word lookup on whole bubbles.

Pages keep mokuro's order. The title, the author (from a leading `[Author]` in the volume name), the
series and the volume number come from the `.mokuro` file, and the language is set to Japanese.
Panels are still detected here, because mokuro has none; mokuro's text boxes help, since panel crops
grow to cover every bubble. Text outside every panel, such as page numbers, is left out. mokuro
writes `…` as three full-width full stops and letters full width; both are folded back, so the
device puts each printed character in its own cell. Webtoon re-cutting cannot be combined with a
mokuro volume.

The firmware fork's `tools/manga_convert/convert_manga.py --input <volume>.mokuro` does the same on
the command line.

## What the panel detection does

Red boxes are the panels found; numbers are their reading order. Pick the **book type** in step
3 and the rest follows.

<details>
<summary><b>Manga</b> — right to left, then down the page</summary>

A full-width panel separates the rows around it, and a tall panel beside two stacked shorter ones
resolves correctly. The order comes from a topological sort, not from clustering panels by their
vertical centre.

<img src="docs/images/panels-manga.jpg" width="360" alt="A manga page with eight numbered panels, walked right to left">
</details>

<details>
<summary><b>4-koma</b> — each column top to bottom, then the next column</summary>

A 4-koma page is two strips side by side, not rows across the page, so it reads down one column
and then down the next; the row-major order would interleave the two gags. It is the same rule
with the axes swapped, so a title page whose left half is one full-height illustration beside a
strip of four still works — the illustration is a column of its own and reads last.

Japanese pages read the right column first. A banner across the top reads before both, being a
tier of its own.

<img src="docs/images/panels-yonkoma-rtl.jpg" width="360" alt="A Japanese 4-koma page: the banner numbered 1, the right strip 2 to 5, the left strip 6 to 9">

Pick the left-to-right variant for a strip page that reads that way, as this English one does.

<img src="docs/images/panels-yonkoma-ltr.jpg" width="360" alt="An English 4-koma page: the left strip numbered 1 to 4, the right strip 5 to 8">
</details>

<details>
<summary><b>Western comic</b> — left to right, then down the page</summary>

The same logic mirrored. The paper border and page number are cropped off first, so the scan
fills the screen.

<img src="docs/images/panels-calvin.jpg" width="360" alt="A Calvin and Hobbes page with eight numbered panels, walked left to right">
</details>

<details>
<summary><b>Western comic</b> — newspaper strip collections</summary>

Trimming the margin before detection is what makes this page come out as all 11 panels.
Untrimmed it returns 9, with one strip left undivided.

<img src="docs/images/panels-moomin-german.jpg" width="360" alt="A Moomin page of four strips with eleven numbered panels">
</details>

<details>
<summary><b>Western comic</b> — another strip page</summary>

Twelve panels across four strips, in reading order.

<img src="docs/images/panels-moomin-english.jpg" width="360" alt="An English Moomin page with twelve numbered panels across four strips">
</details>

<details>
<summary><b>Webtoon / manhwa</b> — one long vertical strip</summary>

The fixed-height tiles it ships in are reassembled and re-cut at the artwork's gutters, so no
page starts or ends mid-panel. A 48-tile chapter became 42 pages filling 90% of the screen on
average.

<img src="docs/images/panels-webtoon.jpg" width="720" alt="Six webtoon pages re-cut from a vertical strip, each with numbered panels">
</details>

### How good the AI detection is

The detector is a YOLO26s model trained on Manga109
([ShadowB/Manga109-panel-balloon-text-yolov26-segmentation](https://huggingface.co/ShadowB/Manga109-panel-balloon-text-yolov26-segmentation)),
run in the browser through ONNX Runtime's WebAssembly backend. It replaced a YOLO26n after both
were scored on 55 hand-labelled pages from 37 series: dense action, 4-koma, splash and title
pages, colour, borderless, slanted and overlapping panels, black gutters, bubbles crossing
borders. None of them is from Manga109. Pages were scored at 480×800, the size the X4 and X4
Pro convert at. A panel counts as found when its box overlaps the drawn panel by IoU 0.75 or
more. A page is exactly right when it has the right number of panels and every one is found.

| | Panels found (F1, IoU ≥ 0.75) | Pages exactly right | Detection per page | Download |
|---|---|---|---|---|
| White-gutter heuristic (no AI) | 13% | 7 of 55 | 1 ms | — |
| YOLO26n (before) | 94.5% | 44 of 55 | 0.15 s | 9.6 MB |
| **YOLO26s (now)** | **98.4%** | **50 of 55** | **0.52 s** | **19.8 MB** |

Times are single-threaded WebAssembly, as GitHub Pages runs it, on a laptop Intel Core Ultra 7
165U: roughly two minutes of detection for a 200-page volume. At full resolution ("Original")
the new model scores 97.8% and 49 of 55; the old one scored 93.7% and 43 of 55. That relies on
large pages being shrunk to the model's input with an area average: the bilinear sampling used
before scored 96.1% and 46 of 55 there, because a hairline frame shrunk threefold falls between
samples. Reading order is unchanged: 44 of the 48 pages where every panel was found come out in
order, and three of the four misses come out wrong even from the hand-drawn boxes. It does best
where the old one struggled. On borderless panels it scores 97% against 82%, on slanted ones 95%
against 87%, and on black gutters 92% against 79%. All three splash pages are now right; the old
model cut the sky off one. The five pages it still gets wrong are hard ones. On a slanted page
with black gutters it merges two panels. It misses a framed card holding only narration, a
borderless lightning strip, and a narrow panel with no top frame. On a collage page it boxes one
panel too loosely.

Also measured, and left out because they did not help: flipped and multi-scale passes with
fused boxes, snapping box edges to the drawn frame lines, tightening boxes with the model's
segmentation masks, combining two models, and running the model at 1280. Bigger models did
no better at many times the cost: RF-DETR Medium (98.0%, 2.7 s a page, 61 MB) and
RT-DETRv4-X (98.4%, 250 MB). The weights are stored as fp16, which scores the same as fp32 at
half the download. The method, the label rules and the harness are in
[test/README.md](test/README.md#panel-detection-benchmark).

## Hosting / running

It's a static site with no build step. Any static host works:

- **GitHub Pages**: enable Pages for this repo (Settings → Pages → Source: *GitHub Actions*).
  The included workflow (`.github/workflows/pages.yml`) deploys on every push to `main`.
- **Locally**: `python3 -m http.server` in the repo root, then open `http://localhost:8000`.

The deploy workflow stamps every `css/` and `js/` URL with the commit SHA
(`js/manga-ui.js?v=42dd0bbd`). Pages caches each file for ten minutes, so without this a browser
can pair a fresh page with a stale script. That happened once and killed every control on the
page. Stamping at deploy time means the version cannot be forgotten, and local development keeps
plain paths.

The vendored ONNX Runtime, PDF.js and the panel model stay unstamped on purpose: pinned, rarely
changed, and 20 MB for the model alone. Bump their paths if one is replaced (the model's lives in
`js/yolo.js:YOLO_MODEL_URL`).

## Manga converter options

| Control | Desktop flag | Effect |
|---|---|---|
| **Export format** | — | Any combination of Matcha Reader `.matcha` file (firmware 2.0.0-rc-4 and up), Matcha Reader legacy folder, EPUB, PDF, XTC, XTCH. Nothing preselected. Later steps adapt to the pick. |
| **Book type** | `--ltr` `--trim-margins` `--webtoon` | Manga reads right to left. Western comic reads left to right and trims the paper border; the detector is manga-trained, so it misses panels on dense strip layouts and the page warns about it. Webtoon reassembles the strip and re-cuts it at the artwork's gutters, no model involved. Nothing preselected. |
| **Panels only** | *(browser only)* | Ships panel crops without full pages. A page whose panels miss artwork keeps its full page; so does the cover. |
| **Device** (screen size cards) | `--device NAME` (or `--x4` / `--x3`) | Downscales before detection. 480×800 for the X4/X4C, X4 Pro, Sticky, Papermono, BOOX Picco and Metalio E-Ink 4; 528×792 for the X3; 552×768 for the EEGO Reader A4; 684×1216 for the Metalio E-Ink 4 Plus; or a custom 1–4096 px size (browser only). Never upscales. Full resolution warns: the Xteink firmware struggles with it. |
| **Translate into** | *(browser only)* | Language the translations come back in. The desktop tool always uses English. |
| **Language** (step 5) | `--language` | Splits reading stats by language, and tells OCR what to expect. `jp`→`ja`, `cn`→`zh`, `kr`→`ko`; `zh-Hant` kept intact. |
| **AI panel detection** | — | A YOLO26s model trained on Manga109, in the browser (a one-time 31 MB download with its runtime). Untick for the white-gutter heuristic, which is also the automatic fallback. Disabled for webtoons, whose panels come from gutters. |
| **Turn wide panels sideways** | — | EPUB, PDF and XTC/XTCH only: those bake in orientation. The Matcha format rotates on the device instead. |
| **Black-and-white pages** | `--mono` | Dithered black-and-white pages. One fast refresh on the device. Best for line art. |
| **Brightness** | *(browser only)* | Gamma applied before dithering, for scans that come out darker than the original. Affects black-and-white pages and XTC/XTCH only. |
| **Dot pattern** | *(browser only)* | Smooth (Floyd–Steinberg), Crisp (Atkinson) or Grid (ordered). Affects black-and-white pages and XTC/XTCH only. |
| **Fix faded scans**, **Sharpen**, **Darker greys** | *(browser only)* | Clean-up before conversion, with a before/after preview. |

**EPUB** is fixed-layout EPUB 3, right-to-left, each page followed by its panels, with the chapter
list carried over. **PDF** holds the same images, one per page, for any PDF viewer. **XTC / XTCH** is Xteink's own format for the stock firmware, 1-bit and 4-level
grayscale; XTCH needs a page height divisible by 8. All are browser-only, as is Panels only.

Panel crops go in a `panels/` subfolder so the device does not walk a crop per panel when opening
the book. The older flat layout still works; re-convert for the faster open.

## Chinese dictionaries

For Chinese and Cantonese the Dictionary page offers ready-made editions, built from sources served
with the page ([`data/README.md`](data/README.md)), so there is nothing to download first:

| Edition | Equivalent desktop run |
|---|---|
| **Simplified** | CC-CEDICT, `--frequency` jieba `dict.txt`, `--levels hsk30.csv --level-name HSK`, Tatoeba `--examples-script simplified`, `--split-names` |
| **Traditional** | The same with jieba `dict.txt.big`, `--levels tocfl-202307.csv --level-name TOCFL`, `--examples-script traditional` and `--zhuyin` |
| **Cantonese** | `--lang yue`, CC-Canto and CC-CEDICT, `--jyutping cccedict-canto-readings`, Tatoeba Cantonese `--examples-script traditional`, `--split-names` |

All three are byte-identical to `convert_jmdict.py` on the same files (the Cantonese one needs
the converter's CC-Canto comment fix, matcha-reader#401). The Chinese two match the firmware's
`dictionaries-zh` release packs, except that the traditional pack also merges the MoE dictionary.
**My own files** opens the full form below. The **Language** choice decides the folder the zip
lays out: `dictionaries/zh/` for Chinese (one folder serves simplified and traditional books
alike, both forms of every word are indexed), `dictionaries/yue/` for Cantonese. Japanese keeps
`dict/`.

| Control | Desktop flag | Effect |
|---|---|---|
| **Dictionary file(s)** | `--input` (repeatable) | CC-CEDICT `.u8`/`.txt`/`.gz`, CC-Canto, `dict-revised.json` (unpack the `.xz` first; the browser has no xz), Yomitan `.zip`, MDict `.mdx`, `.tsv`. Several files merge; a word in two shows both entries, CC-CEDICT first. |
| **Word frequency list** | `--frequency`, `--frequency-kind` | jieba `dict.txt` / `dict.txt.big`, BCC, SUBTLEX, or any one-word-per-row list. Ranks the entries so the common sense shows first and the device's page segmentation prefers common words; a word missing from the list takes its other-script form's rank. |
| **Graded word list** + label | `--levels`, `--level-name` | `hsk30.csv` or `tocfl-202307.csv` from the ivankra repos: each entry gets a `[HSK 3]`-style tag on its grammar line. Variant cells (`你/妳`, `爸爸\|爸`) count for every form. |
| **Example sentences** + script | `--examples`, `--examples-script` | A Tatoeba sentence-pairs export or a `sentence<TAB>translation` file; entries of two or more characters get up to two short examples, in the chosen script only. |
| **Cantonese readings** | `--jyutping` | `cccedict-canto-readings`: jyutping after the pinyin of every CC-CEDICT entry it covers. |
| **Zhuyin** | `--zhuyin` | Bopomofo beside the pinyin. |
| **Proper nouns to names** | `--split-names` | Capitalised CC-CEDICT entries (places, people, dynasties) go to `names.*` and show as Name entries; languages, nationalities, weekdays, months and festivals stay in the vocabulary. |
| **Dictionary name** | `--title` | The footer label, `vocab.title`; default is the sources joined (`CC-CEDICT + MoE`). |

## Furigana & Pinyin

Adds readings above the text of an EPUB, the way the reader shows a book's own ruby, with its
Furigana or Pinyin / Zhuyin toggle to hide them. Existing ruby, scripts, styles and the head are
left alone.

Pinyin is written as spoken: 一 and 不 change tone before the next syllable (一个 yí gè, 不是
bú shì), particles such as 了, 着 and 得 take the neutral tone, and 儿 joins the syllable before it
(哪儿 nǎr). **Dictionary tones only** keeps each character's own tone instead.

| | Dictionary | AI (Gemini) |
|---|---|---|
| **Chinese** — `tools/pinyin_ruby/add_pinyin_ruby.py` | Longest-match segmentation against CC-CEDICT (a built-in copy, or your own file), one `<rt>` per character, the everyday reading of a word over a surname's. Nothing leaves the device. | `--ai`: Gemini reads each sentence and picks the reading meant there (石 *shí* or *dàn*); a reading is used only when CC-CEDICT lists it for that character. |
| **Japanese** — `tools/furigana_ruby/add_furigana_ruby.py` | Page only (the firmware's tool has none): the built-in IPADIC, via [kuromoji.js](https://github.com/takuyaa/kuromoji.js), splits each sentence into words and gives each its likeliest reading (今日 is always *きょう*). Nothing leaves the device. | Gemini lists each word with its reading; a reading is used only when it is kana and fits the word as written, so okurigana stays bare. |

The AI method sends the book's text to Google, sentence by sentence, under your own key (shared
with the Manga page, kept in `localStorage`). Chinese can also leave the N commonest words of a
frequency list bare, and write zhuyin instead of pinyin. The built-in dictionaries and their
licences are listed in [`data/README.md`](data/README.md).

## Fidelity to the firmware's Python tools

Ports of the firmware's scripts, not reimplementations from the spec.

| Tool | Ports | Output |
|---|---|---|
| Manga | `tools/manga_convert/convert_manga.py` | Byte-identical, given the same input pixels, except AI panel detection (below) |
| Dictionary | `tools/dict_convert/convert_jmdict.py` (Japanese, Chinese and Cantonese paths), `scripts/gen_dict_spx.py` | Byte-identical |
| Furigana & Pinyin | `tools/furigana_ruby/add_furigana_ruby.py`, `tools/pinyin_ruby/add_pinyin_ruby.py`, `tools/ruby_common/ruby_epub.py` | Identical XHTML for the same model answers; the zip is stored rather than deflated. Japanese dictionary furigana has no Python counterpart |
| Fonts | `lib/EpdFont/scripts/fontconvert_sdcard.py` | Byte-identical except glyph bitmaps |

**AI panel detection deliberately differs.** `convert_manga.py` runs the YOLO26n model; this fork
runs a YOLO26s model that finds noticeably more panels exactly
([measured](#how-good-the-ai-detection-is)), with a simpler post-processing step: the model's own
boxes after non-maximum suppression, no merging of overlapping boxes and no re-splitting of a
frame into the weaker boxes inside it, both of which cost it panels. Crops grow over the model's
speech-balloon boxes as well as its text boxes, and large pages are shrunk for the model with an
area average. So with AI detection on, panel boxes, crops and `panels.idx` differ from the Python
tool's. The grid heuristic, reading order and everything downstream are unchanged.

Two places where pixels differ, each verified within ±2 px: downscaling and PDF rasterization
(browser canvas and PDF.js instead of Pillow and PyMuPDF), and glyph bitmaps (the browser's font
engine instead of FreeType). Everything else is pixel-exact.

`js/mdx.js` additionally ports `readmdict` for MDict input: engine 1.2/2.0, zlib/LZO/uncompressed
blocks, `Encrypted=2` key-index encryption, and `Encrypted=1` registration encryption given the
owner's code and the email it was issued to. Without one it falls back to a key-block scan, which
recovers most such files.

## Tests

The suite generates reference output with the firmware's Python tools and compares bytes. It
needs a checkout of the firmware repo next door, or `MATCHA_READER=/path/to/repo`:

```bash
pip install Pillow freetype-py fonttools    # for reference generation
pip install numpy onnxruntime               # optional: AI panel-detection references
pip install pymupdf                          # optional: PDF-input references
pip install readmdict python-lzo             # optional: MDict .mdx references (needs liblzo2-dev)
python3 test/gen_references.py             # build fixtures + Python references

npm install onnxruntime-web                # optional: AI detection in the Node tests
node test/node/run.cjs                     # pure-logic byte comparisons (Node ≥ 18)

npm install playwright                     # browser end-to-end (drives the real pages)
python3 /path/to/matcha-reader/lib/EpdFont/scripts/fontconvert_sdcard.py \
  --intervals latin-ext --size 14 --style regular \
  /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
  -o test/fixtures/ref_font/DejaVuSans_14.cpfont
node test/browser/e2e.mjs
```

`test/panels/` scores panel detectors against hand-labelled pages; see
[test/README.md](test/README.md#panel-detection-benchmark).

## Notes & limits

- **Gemini OCR** needs your own API key. Rate limits can make long volumes slow, so
  the converter retries with backoff and keeps the screen awake. *Stop* still packages every
  finished page. The key lives in `localStorage` and goes only to Google.
- **Memory**: pages are processed one at a time, but the output zip is assembled in memory. Very
  large volumes may struggle on low-RAM devices.
- Needs `DecompressionStream`: Chrome/Edge ≥ 80, Safari ≥ 16.4, Firefox ≥ 113.

## License

MIT — see [LICENSE](LICENSE). The panel model in `models/` is not covered by it: it is a
fine-tune of Ultralytics YOLO26 and is treated as AGPL-3.0; see [models/README.md](models/README.md).

Icons: [Tabler Icons](https://tabler.io/icons) by Paweł Kuna, MIT License.
