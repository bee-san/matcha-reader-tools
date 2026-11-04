/* Mokuro input for the manga converter.
 *
 * mokuro (https://github.com/kha-white/mokuro) writes one `<volume>.mokuro` JSON file per volume
 * beside a `<volume>/` folder of page images. Its OCR already carries what panels.dat stores:
 * text blocks with a box, a vertical flag, and each printed line with its own box. A mokuro
 * volume therefore takes the place of the Gemini pass -- no API key, no network -- while panels
 * are still detected here, because mokuro has none.
 *
 * Mirrors the "Mokuro input" section of tools/manga_convert/convert_manga.py in the bee-san
 * matcha-reader fork. Series archives run to several gigabytes, so BlobZip reads only the
 * central directory and the members a volume needs, never the whole file.
 */

/* global sortPanelsReadingOrder, inflateRaw, crc32, isImageName, naturalSortPaths, compareNaturalKeys, naturalSortKey */
const MOKURO_DEPS = typeof module !== "undefined"
  ? { ...require("./manga-core.js"), ...require("./zip.js") }
  : null;
const mokuroDep = (name) => (MOKURO_DEPS ? MOKURO_DEPS[name] : globalThis[name]);

const MOKURO_SUFFIX = ".mokuro";

/* ── A zip read straight from a File/Blob ─────────────────────────── */

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;

class BlobZip {
  constructor(blob, entries) {
    this.blob = blob;
    this.entries = entries;
  }

  async _bytes(start, end) {
    return new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
  }

  /* Reads the end-of-central-directory record (Zip64 too) and the central directory. */
  static async open(blob) {
    const tailLen = Math.min(blob.size, 22 + 0xffff + 20);
    const tail = new Uint8Array(await blob.slice(blob.size - tailLen).arrayBuffer());
    const view = new DataView(tail.buffer);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === ZIP_EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) {
      throw new Error("not a readable zip: it has no directory at the end, which usually means the download never finished");
    }
    let count = view.getUint16(eocd + 10, true);
    let cdSize = view.getUint32(eocd + 12, true);
    let cdOffset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || view.getUint32(loc, true) !== ZIP64_LOCATOR_SIG) throw new Error("damaged Zip64 archive (no locator)");
      const recOffset = Number(view.getBigUint64(loc + 8, true));
      const rec = new DataView((await blob.slice(recOffset, recOffset + 56).arrayBuffer()));
      if (rec.getUint32(0, true) !== ZIP64_EOCD_SIG) throw new Error("damaged Zip64 archive (no directory record)");
      count = Number(rec.getBigUint64(32, true));
      cdSize = Number(rec.getBigUint64(40, true));
      cdOffset = Number(rec.getBigUint64(48, true));
    }
    const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    return new BlobZip(blob, BlobZip._parseCentralDirectory(cd, count));
  }

  static _parseCentralDirectory(cd, count) {
    const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const utf8 = new TextDecoder("utf-8");
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || view.getUint32(p, true) !== ZIP_CENTRAL_SIG) throw new Error("damaged zip directory");
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      let compressedSize = view.getUint32(p + 20, true);
      let size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      let localOffset = view.getUint32(p + 42, true);
      // Archives written by mokuro's users are UTF-8 whatever the flag says; CP437 names
      // would be mojibake for every Japanese title.
      const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
      // Zip64 extended information: only the fields saturated above are present, in this order.
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = view.getUint16(e, true);
        const len = view.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) { size = Number(view.getBigUint64(q, true)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(view.getBigUint64(q, true)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(view.getBigUint64(q, true)); }
        }
        e += 4 + len;
      }
      entries.push({ name, method, crc, size, compressedSize, localOffset, isDir: name.endsWith("/") });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  find(name) {
    return this.entries.find((e) => e.name === name) || null;
  }

  /* One member's bytes, checked against its CRC: a download with pieces missing has a directory
   * that reads fine and members that are zeros. */
  async read(entry) {
    const head = await this._bytes(entry.localOffset, entry.localOffset + 30);
    const view = new DataView(head.buffer);
    if (head.length < 30 || view.getUint32(0, true) !== ZIP_LOCAL_SIG) {
      throw new Error(`${entry.name} is missing from the archive (unfinished download?)`);
    }
    const start = entry.localOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const raw = await this._bytes(start, start + entry.compressedSize);
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = await mokuroDep("inflateRaw")(raw);
    else throw new Error(`${entry.name} uses zip compression method ${entry.method}, which is not supported`);
    if (mokuroDep("crc32")(data) !== entry.crc) throw new Error(`${entry.name} is damaged in the archive (unfinished download?)`);
    return data;
  }
}

/* ── Finding volumes ─────────────────────────────────────────────── */

/* macOS archive litter: resource forks that only look like volumes. */
function mokuroIgnoredPath(path) {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.includes("__MACOSX") || parts[parts.length - 1].startsWith("._");
}

function mokuroStem(path) {
  const base = path.replace(/\\/g, "/").split("/").pop();
  return base.slice(0, base.length - MOKURO_SUFFIX.length);
}

/* Volumes in an archive, in natural order: [{ name, member }]. */
function mokuroVolumesInZip(entries) {
  const members = entries
    .filter((e) => !e.isDir && e.name.toLowerCase().endsWith(MOKURO_SUFFIX) && !mokuroIgnoredPath(e.name))
    .map((e) => e.name);
  return mokuroDep("naturalSortPaths")(members).map((member) => ({ name: mokuroStem(member), member }));
}

/* A relative image path from the .mokuro file, or null when it would escape its folder. */
function mokuroSafeRelPath(name) {
  const norm = String(name || "").replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return null;
  const parts = [];
  for (const seg of norm.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

function parseMokuro(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`the .mokuro file is not valid JSON (${e.message})`); }
  if (!data || typeof data !== "object" || !Array.isArray(data.pages) || !data.pages.length) {
    throw new Error("the .mokuro file has no pages; is it a mokuro volume file?");
  }
  return data;
}

/* ── Metadata ────────────────────────────────────────────────────── */

const MOKURO_BRACKETED_AUTHOR = /^\s*[[(［（【](?<author>[^\])］）】]+)[\])］）】]\s*(?<rest>.+)$/u;
const MOKURO_VOLUME_NUMBER = [
  /第\s*(\d+(?:\.\d+)?)\s*巻/u,
  /\b(?:v|vol|volume)\.?\s*(\d+(?:\.\d+)?)/iu,
  // A bare trailing number only when set apart: "Yotsuba to! 07", not "20世紀少年".
  /(?:^|[\s_-])(\d+(?:\.\d+)?)\s*$/u,
];

/* {title, author, series, seriesIndex} from a volume's mokuro header. `title` in the file is the
 * series and `volume` the book; volume names lead with the author in brackets --
 * "[ヒロユキ] アホガール 第01巻". */
function mokuroMetadata(data) {
  const series = String(data.title || "").trim();
  // Replacement characters: names whose encoding was lost before mokuro ran ("��23��").
  let title = String(data.volume || "").replace(/\uFFFD/g, "").trim();
  let author = "";
  const m = MOKURO_BRACKETED_AUTHOR.exec(title);
  if (m) {
    author = m.groups.author.trim();
    title = m.groups.rest.trim();
  }
  // NFKC folds the full-width digits these names often use, for matching only.
  const folded = title.normalize("NFKC");
  let seriesIndex = null;
  for (const re of MOKURO_VOLUME_NUMBER) {
    const n = re.exec(folded);
    if (n) { seriesIndex = parseFloat(n[1]); break; }
  }
  // A bare number says which volume, not which book.
  if (series && /^[\d\s._-]*$/u.test(folded)) title = `${series} ${title}`.trim();
  return { title: title || series, author, series, seriesIndex };
}

/* ── Text ────────────────────────────────────────────────────────── */

/* manga-ocr, which mokuro uses, writes an ellipsis as three full-width full stops and letters and
 * digits full width. The device gives each of those its own character cell along a printed line,
 * where the lettering has one cell for "…" and one for a short Latin run ("OK", "360"), so every
 * character after them would land a cell or more off. Fold them back to what was printed. */
function mokuroLineText(line) {
  return String(line).trim().replace(/．．．/g, "…")
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/* One page's mokuro blocks in output page pixels, as {box, text, lines, vertical}.
 *
 * mokuro measured the page as img_width x img_height. The converter may then have cropped the
 * margin (cropOrigin/cropSize, in source pixels) and downscaled the result to pageSize, so every
 * point goes through all three. Line boxes are kept only when every line has text and a box:
 * line i must be the i-th '\n' segment of the text, and a partial set would put every later line
 * on the wrong one. */
function mokuroTextBlocks(record, sourceSize, cropOrigin, cropSize, pageSize, warn = () => {}) {
  const [srcW, srcH] = sourceSize;
  const measuredW = record.img_width || srcW;
  const measuredH = record.img_height || srcH;
  if (Math.abs(srcW / srcH - measuredW / measuredH) > 0.02 * srcW / srcH) {
    // Rotated or re-cropped since mokuro read it: its boxes no longer fit this image.
    warn(`page ${record.img_path} is ${srcW}x${srcH} but mokuro measured ${measuredW}x${measuredH}; its text is skipped`);
    return [];
  }
  const [ox, oy] = cropOrigin;
  const [cw, ch] = cropSize;
  const [pw, ph] = pageSize;
  const kx = (srcW / measuredW) * (pw / cw), ky = (srcH / measuredH) * (ph / ch);
  const offX = (ox * pw) / cw, offY = (oy * ph) / ch;
  const clamp = (v, hi) => Math.max(0, Math.min(hi, Math.round(v)));
  const toPage = (x1, y1, x2, y2) => {
    const box = [clamp(x1 * kx - offX, pw), clamp(y1 * ky - offY, ph), clamp(x2 * kx - offX, pw), clamp(y2 * ky - offY, ph)];
    return box[2] > box[0] && box[3] > box[1] ? box : null;
  };

  const blocks = [];
  for (const block of record.blocks || []) {
    if (!block || !Array.isArray(block.lines)) continue;
    const texts = block.lines.map(mokuroLineText);
    const b = Array.isArray(block.box) && block.box.length === 4 ? block.box.map(Number) : null;
    const box = b && b.every(Number.isFinite) ? toPage(...b) : null;
    if (!box || !texts.some(Boolean)) continue;
    let lines = [];
    const coords = block.lines_coords;
    if (texts.every(Boolean) && Array.isArray(coords) && coords.length === texts.length) {
      for (const quad of coords) {
        const xs = Array.isArray(quad) ? quad.map((pt) => Number(pt && pt[0])) : [];
        const ys = Array.isArray(quad) ? quad.map((pt) => Number(pt && pt[1])) : [];
        const line = xs.length && xs.every(Number.isFinite) && ys.every(Number.isFinite)
          ? toPage(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)) : null;
        if (!line) { lines = []; break; }
        lines.push(line);
      }
    }
    const text = lines.length ? texts.join("\n") : texts.filter(Boolean).join("\n");
    blocks.push({ box, text, lines: lines.slice(0, 255), vertical: !!block.vertical });
  }
  return blocks;
}

function mokuroOverlap(a, b) {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
}

/* Each text block goes to the panel it is drawn in, in reading order within the panel.
 *
 * Ownership is decided against the panel frames as drawn and falls back to the grown crop boxes
 * for a bubble outside every frame. A block outside every crop -- a page number, a note in the
 * margin -- is dropped: the zoomed panel it would be filed under does not show it. mokuro lists
 * blocks in detection order, so each panel's are sorted; that is the order the word cursor steps
 * through them on the device. */
function mokuroAssignTextToPanels(blocks, frames, boxes, rtl = true) {
  const owned = boxes.map(() => []);
  for (const block of blocks) {
    for (const candidates of [frames, boxes]) {
      if (!candidates || !candidates.length) continue;
      let owner = 0;
      let best = -1;
      candidates.forEach((c, i) => {
        const o = mokuroOverlap(c, block.box);
        if (o > best) { best = o; owner = i; }
      });
      if (best > 0) { owned[owner].push(block); break; }
    }
  }
  const sort = mokuroDep("sortPanelsReadingOrder");
  return owned.map((group) => {
    if (group.length < 2) return group;
    const byBox = new Map(group.map((b) => [b.box, b]));
    return sort(group.map((b) => b.box), rtl).map((box) => byBox.get(box));
  });
}

/* ── Collecting a volume's pages ─────────────────────────────────── */

/* Pages of one volume in mokuro's order, each carrying its OCR record. A page image that is
 * missing fails the volume: a book with pages silently gone would look complete. */
function mokuroPages(data, readImage, sourceLabel) {
  const missing = [];
  const pages = [];
  for (const record of data.pages) {
    const rel = record && mokuroSafeRelPath(record.img_path);
    const read = rel ? readImage(rel) : null;
    if (!read) { missing.push(String(record && record.img_path)); continue; }
    pages.push({ name: rel, read, mokuro: record });
  }
  if (missing.length) {
    throw new Error(`${missing.length} page image(s) listed in ${sourceLabel} are missing, e.g. ${missing[0]}`);
  }
  const meta = mokuroMetadata(data);
  return {
    pages,
    // mokuro's OCR model reads Japanese only.
    meta: { title: meta.title, author: meta.author, language: "ja", series: meta.series, seriesIndex: meta.seriesIndex },
    tocEntries: [],
    tocSource: "",
    sourceLabel,
    mokuro: true,
  };
}

/* One volume of a series archive: its .mokuro member and the `<volume>/` folder beside it. */
async function collectFromMokuroZip(zip, volume) {
  const data = parseMokuro(new TextDecoder().decode(await zip.read(zip.find(volume.member))));
  const prefix = volume.member.slice(0, volume.member.length - MOKURO_SUFFIX.length) + "/";
  const byPath = new Map();
  for (const e of zip.entries) {
    if (!e.isDir && e.name.startsWith(prefix)) byPath.set(e.name.slice(prefix.length), e);
  }
  return mokuroPages(data, (rel) => {
    const entry = byPath.get(rel);
    return entry ? () => zip.read(entry) : null;
  }, volume.name);
}

/* A .mokuro file chosen together with its page images (from a folder pick, or selected
 * together). Images match by their path under the volume folder, then by file name. */
async function collectFromMokuroFiles(files, mokuroFile) {
  const data = parseMokuro(await mokuroFile.text());
  const stem = mokuroStem(mokuroFile.webkitRelativePath || mokuroFile.name);
  const byRel = new Map();
  const byBase = new Map();
  for (const f of files) {
    if (!mokuroDep("isImageName")(f.name)) continue;
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
    const at = rel.indexOf(`${stem}/`);
    if (at >= 0) byRel.set(rel.slice(at + stem.length + 1), f);
    byBase.set(f.name, f);
  }
  return mokuroPages(data, (rel) => {
    const f = byRel.get(rel) || byBase.get(rel.split("/").pop());
    return f ? async () => new Uint8Array(await f.arrayBuffer()) : null;
  }, mokuroFile.name);
}

if (typeof module !== "undefined") {
  module.exports = {
    BlobZip, MOKURO_SUFFIX, mokuroIgnoredPath, mokuroVolumesInZip, mokuroSafeRelPath, parseMokuro,
    mokuroMetadata, mokuroLineText, mokuroTextBlocks, mokuroAssignTextToPanels, mokuroPages,
    collectFromMokuroZip, collectFromMokuroFiles,
  };
}
