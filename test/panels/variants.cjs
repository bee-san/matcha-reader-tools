/* Detector variants test/panels/eval.cjs can score. Each is
 *   { models: [file, ...] | (ctx) => [...], run: async (ctx, rgba, w, h, info) => frames }
 * where info is {id, rtl, columnMajor} for the page and frames are [x1, y1, x2, y2] panel boxes
 * in the page's pixels, in any order (the harness sorts them the way the converter does).
 * `models` is what the variant downloads, for the size column and to skip a variant whose files
 * are absent. */
"use strict";

const path = require("path");
const yolo = require("../../js/yolo.js");
const manga = require("../../js/manga-core.js");

const SHIPPED = path.join(__dirname, "..", "..", "models", "manga_panel_detector_yolo26n.onnx");

module.exports = {
  // The white-gutter heuristic: the converter's fallback, with no model at all.
  grid: {
    models: [],
    async run(ctx, rgba, w, h) {
      return manga.detectPanelsGrid(manga.grayFromRGBA(rgba, w, h), w, h);
    },
  },
  // What the converter ships: detectPanelsYolo() and its model.
  shipped: {
    models: [SHIPPED],
    async run(ctx, rgba, w, h) {
      const session = await ctx.session(SHIPPED);
      return (await yolo.detectPanelsYolo(session, ctx.ort, rgba, w, h)).frames;
    },
  },
};
