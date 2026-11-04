/* manga.html with a mokuro series archive: pick a volume, convert, and check the device data
 * carries mokuro's text and line boxes. Not part of e2e.mjs: it needs a real mokuro archive,
 * which cannot be committed.
 *
 *   node test/browser/mokuro-e2e.mjs path/to/Series.zip [volume-index] [max-pages]
 *
 * With SCREENAI=1 the text is read by the Screen AI helper instead of taken from mokuro; start it
 * first with `python3 tools/manga_convert/screenai.py --serve` in the firmware repo.
 */
import { chromium } from "playwright";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [archive, volumeArg = "0", maxPagesArg = "6"] = process.argv.slice(2);
if (!archive) { console.error("usage: mokuro-e2e.mjs Series.zip [volume-index] [max-pages]"); process.exit(2); }
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "mokuro-e2e-"));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".onnx": "application/octet-stream", ".wasm": "application/wasm", ".mjs": "text/javascript", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); failures++; }
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(`${base}/manga.html`);
await page.$$eval("details", (ds) => ds.forEach((d) => { d.open = true; }));
await page.setInputFiles("#manga-file", archive);
await page.waitForSelector("#mokuro-volume-row:not([hidden])", { timeout: 60000 });
const volumes = await page.$$eval("#mokuro-volume option", (os) => os.map((o) => o.textContent));
check("volume picker lists the archive's volumes", volumes.length > 0, String(volumes.length));
check("mokuro's own text is offered and picked", await page.isChecked('input[name="ocr-engine"][value="mokuro"]'));
if (process.env.SCREENAI) {
  await page.check('input[name="ocr-engine"][value="screenai"]');
  await page.waitForFunction(() => /ready/.test(document.querySelector("#screenai-status").textContent), null, { timeout: 10000 });
  check("Screen AI helper found", true);
}
await page.selectOption("#mokuro-volume", volumeArg);
await page.check('input[name="booktype"][value="manga"]');
for (const f of ["matcha", "matchafile", "epub", "pdf", "xtc", "xtch"]) {
  const sel = `#manga-format .fmt[value="${f}"]`;
  if (await page.$(sel)) { if (f === "matcha") await page.check(sel); else await page.uncheck(sel); }
}
await page.check('input[name="screen"][value="480x800"]');
await page.fill("#manga-max-pages", maxPagesArg);
const t0 = Date.now();
const [download] = await Promise.all([page.waitForEvent("download", { timeout: 600000 }), page.click("#manga-run")]);
const zipFile = path.join(OUT, download.suggestedFilename());
await download.saveAs(zipFile);
console.log(`  converted ${volumes[Number(volumeArg)]} (${maxPagesArg} pages) in ${Date.now() - t0} ms -> ${zipFile}`);
const log = await page.$eval("#manga-log", (el) => el.textContent).catch(() => "");
check("no Gemini key was needed", !/API key/i.test(log));

const dest = path.join(OUT, "out");
execFileSync("python3", ["-I", "-c", "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: z.extractall(sys.argv[2])", zipFile, dest]);
const idxPath = execFileSync("find", [dest, "-name", "panels.idx"]).toString().trim().split("\n")[0];
check("panels.idx written", !!idxPath);
const dir = path.dirname(idxPath);
const idx = fs.readFileSync(idxPath), dat = fs.readFileSync(path.join(dir, "panels.dat"));
const pages = idx.readUInt32LE(4);
let blocks = 0, withLines = 0, vertical = 0, ellipses = 0, fullwidthDots = 0;
for (let p = 0; p < pages; p++) {
  let o = idx.readUInt32LE(8 + 12 * p);
  const panelCount = dat[o]; o += 2;
  for (let i = 0; i < panelCount; i++) {
    const textCount = dat[o + 8]; const tl = dat.readUInt16LE(o + 10); o += 12 + tl + 8;
    for (let j = 0; j < textCount; j++) {
      const len = dat.readUInt16LE(o + 8); const text = dat.subarray(o + 10, o + 10 + len).toString("utf8"); o += 10 + len;
      const lineCount = dat[o], flags = dat[o + 1]; o += 2 + 8 * lineCount;
      blocks++; if (lineCount) withLines++; if (flags & 1) vertical++;
      if (text.includes("…")) ellipses++; if (text.includes("．．．")) fullwidthDots++;
    }
  }
}
console.log(`  ${pages} pages, ${blocks} text blocks, ${withLines} with line boxes, ${vertical} vertical, ${ellipses} with …`);
check("text blocks carried over from mokuro", blocks > 0);
// Older mokuro output has no lines_coords (those blocks fall back to whole-block lookup); Screen AI
// always gives each line's box.
if (process.env.SCREENAI) check("every block has line boxes for word selection", withLines === blocks, `${withLines}/${blocks}`);
check("ellipses folded to one cell", fullwidthDots === 0);
const meta = fs.readFileSync(path.join(dir, "meta.bin"));
check("meta.bin carries the language", meta.includes(Buffer.from("ja")));

await browser.close();
server.close();
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("mokuro e2e passed");
