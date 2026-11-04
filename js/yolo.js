/* AI panel detection: a YOLO26s model trained on Manga109
 * (ShadowB/Manga109-panel-balloon-text-yolov26-segmentation), run client-side with ONNX Runtime
 * Web. The shipped file keeps only the detection head: the segmentation branch is cut off, since
 * panels.dat stores rectangles and the masks did not make them any tighter. Its weights are
 * stored as fp16, each cast back to fp32 by a Cast node that ONNX Runtime folds away when the
 * session loads: half the download, and inference still runs in fp32. test/panels/README.md has
 * the benchmark behind these choices.
 *
 * Pure logic only in this file: preprocessing (letterbox), output decoding with non-maximum
 * suppression, and growing crops over speech balloons. Session creation and lazy runtime loading
 * live in manga-ui.js, so Node tests can drive these functions with onnxruntime-web's wasm
 * backend directly.
 */
"use strict";

const YOLO_MODEL_URL = "models/manga109_panels_yolo26s_fp16.onnx";
const YOLO_INPUT_SIZE = 640;
const YOLO_STRIDE = 32;            // ultralytics LetterBox(auto=True) pads to this multiple
const YOLO_NUM_CLASSES = 3;
const YOLO_PANEL_CLASS = 0;        // Manga109's "frame"
const YOLO_TEXT_CLASS = 1;
const YOLO_BALLOON_CLASS = 2;
/* Panel score bar. 0.35 to 0.5 score alike on the benchmark's development half; 0.45 drops one
 * false panel there that 0.35 keeps. */
const YOLO_CONF_THRESHOLD = 0.45;
/* Text and balloon boxes only grow crops, so a slightly looser bar costs little. */
const YOLO_TEXT_CONF = 0.4;
/* Per-class non-maximum suppression, as ultralytics' predict() does by default. */
const YOLO_NMS_IOU = 0.7;

/* convert_manga.py:TEXT_OWNERSHIP_MIN_FRAC — fraction of a text box's area that
 * must fall inside a panel before that panel is grown to cover it. A bubble
 * straddling a gutter belongs to whichever panel holds most of it; below this it
 * is page furniture (page numbers, credits, a title banner in the margin) that no
 * panel should be stretched to reach. */
const TEXT_OWNERSHIP_MIN_FRAC = 0.25;

/* convert_manga.py:TEXT_PAD_FRAC_OF_PAGE / TEXT_PAD_MIN — breathing room put
 * around a text box before a panel is grown over it, so the crop edge does not
 * land on the bubble's own outline. */
const TEXT_PAD_FRAC_OF_PAGE = 0.02;
const TEXT_PAD_MIN = 6;

/* Resampling weights along one axis, from `src` pixels to `dst`: for each destination pixel a
 * list of [source index, weight] summing to 1. Shrinking averages every source pixel the
 * destination pixel covers (a box filter, partial pixels weighted by coverage); enlarging
 * interpolates the two nearest (bilinear, pixel centres aligned as cv2.INTER_LINEAR does).
 *
 * Bilinear alone samples only two source pixels per output pixel, so a page shrunk by 3x
 * aliases: hairline frames break up and screentone turns to noise. On the panel benchmark at
 * full resolution that cost 6 points of exactly-right pages against the box filter. */
function yoloAxisWeights(dst, src) {
  const out = new Array(dst);
  const ratio = src / dst;
  for (let i = 0; i < dst; i++) {
    if (ratio > 1) {
      const lo = i * ratio, hi = (i + 1) * ratio;
      const taps = [];
      for (let k = Math.floor(lo); k < Math.min(src, Math.ceil(hi)); k++) {
        taps.push([k, (Math.min(k + 1, hi) - Math.max(k, lo)) / ratio]);
      }
      out[i] = taps;
    } else {
      const sPos = Math.min(Math.max((i + 0.5) * ratio - 0.5, 0), src - 1);
      const k0 = Math.floor(sPos);
      const k1 = Math.min(k0 + 1, src - 1);
      const f = sPos - k0;
      out[i] = [[k0, 1 - f], [k1, f]];
    }
  }
  return out;
}

/* Letterbox an RGBA image into a float32 CHW tensor (RGB, /255), padding with
 * 114-gray. Reproduces the geometry of ultralytics' LetterBox(new_shape=640,
 * auto=True, stride=32) — the preprocessing `model.predict()` applies — which is
 * RECTANGULAR: the long side is scaled to 640 and the short side is padded only
 * up to the next multiple of 32, not out to a square. Squaring the input
 * instead changes the apparent scale of everything in the page and moves the
 * model's confidences enough to gain and lose whole panels. The resize itself
 * is yoloAxisWeights(): area-averaged when shrinking, bilinear when enlarging.
 *
 * Returns {data, netW, netH, scale, padX, padY}; netW/netH are the tensor's
 * spatial dims and scale/pad map detected boxes back to source pixels. */
function yoloLetterbox(rgba, w, h, size, stride) {
  size = size || YOLO_INPUT_SIZE;
  stride = stride || YOLO_STRIDE;
  const scale = Math.min(size / w, size / h);
  const newW = Math.round(w * scale);
  const newH = Math.round(h * scale);

  // ultralytics: dw/dh are the leftover padding modulo the stride, halved, then
  // split with its round(x-0.1) / round(x+0.1) rule so odd padding favours the
  // bottom/right edge.
  const dw = ((size - newW) % stride) / 2;
  const dh = ((size - newH) % stride) / 2;
  const padX = Math.max(0, Math.round(dw - 0.1));
  const padY = Math.max(0, Math.round(dh - 0.1));
  const netW = newW + padX + Math.max(0, Math.round(dw + 0.1));
  const netH = newH + padY + Math.max(0, Math.round(dh + 0.1));

  const plane = netW * netH;
  const data = new Float32Array(3 * plane).fill(114 / 255);

  // Each axis maps by its OWN ratio (newW/w and newH/h), as cv2.resize does, not
  // by the single letterbox gain: newW is rounded, so sampling both axes at
  // `scale` would walk up to a third of a pixel off by the far edge.
  const wx = yoloAxisWeights(newW, w);
  const wy = yoloAxisWeights(newH, h);
  const rowAcc = new Float32Array(newW * 3);
  for (let y = 0; y < newH; y++) {
    rowAcc.fill(0);
    for (const [sy, fy] of wy[y]) {
      if (fy === 0) continue;
      const srcRow = sy * w;
      for (let x = 0; x < newW; x++) {
        let r = 0, g = 0, b = 0;
        for (const [sx, fx] of wx[x]) {
          const p = (srcRow + sx) * 4;
          r += rgba[p] * fx; g += rgba[p + 1] * fx; b += rgba[p + 2] * fx;
        }
        rowAcc[x * 3] += r * fy; rowAcc[x * 3 + 1] += g * fy; rowAcc[x * 3 + 2] += b * fy;
      }
    }
    const row = (padY + y) * netW + padX;
    for (let x = 0; x < newW; x++) {
      data[row + x] = rowAcc[x * 3] / 255;
      data[plane + row + x] = rowAcc[x * 3 + 1] / 255;
      data[2 * plane + row + x] = rowAcc[x * 3 + 2] / 255;
    }
  }
  return { data, netW, netH, scale, padX, padY };
}

function yoloBoxArea(b) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function yoloOverlapArea(a, b) {
  const ox1 = Math.max(a[0], b[0]), oy1 = Math.max(a[1], b[1]);
  const ox2 = Math.min(a[2], b[2]), oy2 = Math.min(a[3], b[3]);
  return Math.max(0, ox2 - ox1) * Math.max(0, oy2 - oy1);
}

function yoloIoU(a, b) {
  const inter = yoloOverlapArea(a, b);
  const union = yoloBoxArea(a) + yoloBoxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/* Greedy non-maximum suppression within one class: highest score first, dropping any box that
 * overlaps an already kept one by more than `iou`. Takes and returns [box, score, cls]. */
function yoloNms(dets, iou) {
  const ordered = dets.slice().sort((a, b) => b[1] - a[1]);
  const kept = [];
  for (const d of ordered) {
    if (kept.every((k) => yoloIoU(k[0], d[0]) <= iou)) kept.push(d);
  }
  return kept;
}

/* Decode the raw ultralytics head — a [1, 4 + classes (+ mask coefficients), N] tensor holding,
 * per anchor, (cx, cy, w, h) in letterboxed pixels and one score per class — into
 * [box, score, class] triples in source-image pixels. Each anchor takes its best class; anything
 * under `minConf` is dropped, and boxes of one class that overlap are suppressed. */
function yoloDecodeHead(out, dims, lb, imgW, imgH, minConf) {
  const n = dims[2];
  const byClass = Array.from({ length: YOLO_NUM_CLASSES }, () => []);
  const toX = (v) => Math.min(Math.max((v - lb.padX) / lb.scale, 0), imgW);
  const toY = (v) => Math.min(Math.max((v - lb.padY) / lb.scale, 0), imgH);
  for (let i = 0; i < n; i++) {
    let cls = -1, score = 0;
    for (let c = 0; c < YOLO_NUM_CLASSES; c++) {
      const s = out[(4 + c) * n + i];
      if (s > score) { score = s; cls = c; }
    }
    if (cls < 0 || score < minConf) continue;
    const cx = out[i], cy = out[n + i], bw = out[2 * n + i], bh = out[3 * n + i];
    const box = [toX(cx - bw / 2), toY(cy - bh / 2), toX(cx + bw / 2), toY(cy + bh / 2)];
    if (box[2] - box[0] < 1 || box[3] - box[1] < 1) continue;
    byClass[cls].push([box, score, cls]);
  }
  return byClass.flatMap((list) => yoloNms(list, YOLO_NMS_IOU));
}

/* Padding to put around a text box before growing a panel over it, scaled to
 * the page so it behaves the same on a 290px thumbnail and a 2000px scan.
 * Port of convert_manga.py:text_pad_px. */
function yoloTextPadPx(pageW, pageH) {
  return Math.max(TEXT_PAD_MIN, Math.round(Math.min(pageW, pageH) * TEXT_PAD_FRAC_OF_PAGE));
}

/* Grow each panel box to cover the speech bubbles and caption boxes that belong
 * to it. Manga bubbles routinely overhang the frame they are spoken in -- drawn
 * on top of the border, or pushed out into the gutter -- and cropping on the
 * detected frame alone slices the text off mid-word.
 *
 * Ownership is decided against the ORIGINAL panel boxes and on the UNPADDED text
 * box, so neither a panel's growth nor the padding can claim a neighbour's
 * bubbles. Only sides the bubble actually breaches move, so a balloon drawn just
 * inside the frame leaves the crop exactly where it was.
 *
 * Index-preserving: the caller fixes reading order on the frames first, and this
 * returns the expanded boxes in the same order. Port of
 * convert_manga.py:expand_panels_over_text. */
function yoloExpandPanelsOverText(panels, texts, pageW, pageH) {
  if (!texts || !texts.length) return panels;

  const pad = yoloTextPadPx(pageW, pageH);
  const expanded = panels.map((p) => p.slice());
  for (const text of texts) {
    const textArea = yoloBoxArea(text);
    if (textArea <= 0) continue;
    let owner = -1, bestOverlap = 0;
    for (let i = 0; i < panels.length; i++) {
      const overlap = yoloOverlapArea(panels[i], text);
      if (overlap > bestOverlap) { owner = i; bestOverlap = overlap; }
    }
    if (owner < 0 || bestOverlap < textArea * TEXT_OWNERSHIP_MIN_FRAC) continue;
    const base = panels[owner], box = expanded[owner];
    if (text[0] < base[0]) box[0] = Math.min(box[0], text[0] - pad);
    if (text[1] < base[1]) box[1] = Math.min(box[1], text[1] - pad);
    if (text[2] > base[2]) box[2] = Math.max(box[2], text[2] + pad);
    if (text[3] > base[3]) box[3] = Math.max(box[3], text[3] + pad);
  }

  for (const box of expanded) {
    box[0] = Math.max(0, box[0]);
    box[1] = Math.max(0, box[1]);
    box[2] = Math.min(pageW, box[2]);
    box[3] = Math.min(pageH, box[3]);
  }
  return expanded;
}

/* Sort decoded [box, score, class] triples into {frames, texts}: panel boxes at or above `conf`,
 * or one full-page box when none clears it, and the text and balloon boxes at or above
 * YOLO_TEXT_CONF. Boxes become integer pixels, rounded outward so a crop never shaves the frame
 * line off. */
function yoloSplitDetections(dets, w, h, conf) {
  const frames = [], texts = [];
  for (const [box, score, cls] of dets) {
    const b = [Math.floor(box[0]), Math.floor(box[1]), Math.ceil(box[2]), Math.ceil(box[3])];
    if (cls === YOLO_PANEL_CLASS) {
      if (score >= conf) frames.push(b);
    } else if (score >= YOLO_TEXT_CONF) {
      texts.push(b);
    }
  }
  return { frames: frames.length ? frames : [[0, 0, w, h]], texts };
}

/* One page through the model. Returns {frames, texts}: the panels as drawn (what reading order is
 * derived from) and the text and balloon boxes yoloExpandPanelsOverText() then grows the CROP
 * rectangles over; a balloon box covers the whole bubble outline, a text box only its glyphs.
 * `session` is an ONNX Runtime InferenceSession for YOLO_MODEL_URL; `ortApi` is the onnxruntime
 * module (for its Tensor constructor). */
async function detectPanelsYolo(session, ortApi, rgba, w, h, conf) {
  conf = conf === undefined ? YOLO_CONF_THRESHOLD : conf;
  const lb = yoloLetterbox(rgba, w, h, YOLO_INPUT_SIZE);
  // The model is exported with dynamic height/width so the rectangular
  // letterbox above can be fed as-is, exactly as ultralytics does.
  const feeds = { [session.inputNames[0]]: new ortApi.Tensor("float32", lb.data, [1, 3, lb.netH, lb.netW]) };
  const results = await session.run(feeds);
  const output = results[session.outputNames[0]];
  const dets = yoloDecodeHead(output.data, output.dims, lb, w, h, Math.min(conf, YOLO_TEXT_CONF));
  return yoloSplitDetections(dets, w, h, conf);
}

if (typeof module !== "undefined") {
  module.exports = {
    YOLO_MODEL_URL, YOLO_INPUT_SIZE, YOLO_STRIDE, YOLO_NUM_CLASSES, YOLO_CONF_THRESHOLD,
    YOLO_TEXT_CONF, YOLO_NMS_IOU, YOLO_PANEL_CLASS, YOLO_TEXT_CLASS, YOLO_BALLOON_CLASS,
    TEXT_OWNERSHIP_MIN_FRAC, TEXT_PAD_FRAC_OF_PAGE, TEXT_PAD_MIN,
    yoloAxisWeights, yoloLetterbox, yoloDecodeHead, yoloNms, yoloIoU, yoloSplitDetections,
    yoloBoxArea, yoloOverlapArea, yoloTextPadPx, yoloExpandPanelsOverText, detectPanelsYolo,
  };
}
