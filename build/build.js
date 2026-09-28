#!/usr/bin/env node
/*
 * build.js — assembles .sky plugin packages for SkyStream.
 *
 * For each provider directory under plugins/:
 *   1. Read plugin.json (manifest)
 *   2. Concatenate build/lib/cs3compat.js + plugins/<name>/plugin.js -> plugin.js (bundled)
 *   3. Write a ZIP archive to dist/<packageName>.sky containing:
 *        - plugin.json   (manifest)
 *        - plugin.js     (cs3compat + provider code, bundled)
 *   4. Emit an entry into dist/plugins.json (SkyStream plugin-list format)
 *
 * Output:
 *   dist/<packageName>.sky            (one per provider)
 *   dist/plugins.json                 (array of plugin manifest entries + .sky URL)
 *
 * After building, commit dist/ and publish the repo. The SkyStream repository URL
 * the user adds to SkyStream is:  <raw-repo-url>/repo.json
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");
const DIST_DIR = path.join(ROOT, "dist");
const LIB_FILE = path.join(ROOT, "build", "lib", "cs3compat.js");

// ---------- minimal ZIP writer (STORE + CRC32, no external deps) ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal ZIP using DEFLATE for each entry. Produces a valid ZIP that `unzip`,
// Java ZipInputStream, and SkyStream's archive.extractAll can read.
function makeZip(entries) {
  // entries: [{ name: string, data: Buffer }]
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const dataBuf = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const crc = crc32(dataBuf);
    // DEFLATE
    const compressed = zlib.deflateRawSync(dataBuf, { level: 9 });
    const useDeflate = compressed.length < dataBuf.length;
    const method = useDeflate ? 8 : 0;
    const compBuf = useDeflate ? compressed : dataBuf;
    const compSize = compBuf.length;
    const uncompSize = dataBuf.length;

    // Local file header (30 bytes + name)
    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0);          // signature
    lfh.writeUInt16LE(20, 4);                  // version needed
    lfh.writeUInt16LE(0, 6);                   // flags
    lfh.writeUInt16LE(method, 8);              // compression method
    lfh.writeUInt16LE(0, 10);                  // mod time
    lfh.writeUInt16LE(0, 12);                  // mod date
    lfh.writeUInt32LE(crc, 14);                // crc32
    lfh.writeUInt32LE(compSize, 18);           // compressed size
    lfh.writeUInt32LE(uncompSize, 22);         // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);      // name length
    lfh.writeUInt16LE(0, 28);                  // extra length
    nameBuf.copy(lfh, 30);

    localParts.push(lfh, compBuf);
    const localOffset = offset;
    offset += lfh.length + compBuf.length;

    // Central directory record (46 bytes + name)
    const cdr = Buffer.alloc(46 + nameBuf.length);
    cdr.writeUInt32LE(0x02014b50, 0);          // signature
    cdr.writeUInt16LE(20, 4);                  // version made by
    cdr.writeUInt16LE(20, 6);                  // version needed
    cdr.writeUInt16LE(0, 8);                   // flags
    cdr.writeUInt16LE(method, 10);             // method
    cdr.writeUInt16LE(0, 12);                  // mod time
    cdr.writeUInt16LE(0, 14);                  // mod date
    cdr.writeUInt32LE(crc, 16);                // crc
    cdr.writeUInt32LE(compSize, 20);          // compressed
    cdr.writeUInt32LE(uncompSize, 24);         // uncompressed
    cdr.writeUInt16LE(nameBuf.length, 28);     // name len
    cdr.writeUInt16LE(0, 30);                  // extra len
    cdr.writeUInt16LE(0, 32);                  // comment len
    cdr.writeUInt16LE(0, 34);                  // disk number
    cdr.writeUInt16LE(0, 36);                  // internal attrs
    cdr.writeUInt32LE(0, 38);                  // external attrs
    cdr.writeUInt32LE(localOffset, 42);        // local header offset
    nameBuf.copy(cdr, 46);
    centralParts.push(cdr);
  }
  const cdOffset = offset;
  let cdSize = 0;
  centralParts.forEach(function (b) { cdSize += b.length; });

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// ---------- main ----------
function loadPlugins() {
  const libSrc = fs.readFileSync(LIB_FILE, "utf8");
  const dirs = fs.readdirSync(PLUGINS_DIR).filter(function (d) {
    return fs.statSync(path.join(PLUGINS_DIR, d)).isDirectory()
      && fs.existsSync(path.join(PLUGINS_DIR, d, "plugin.json"))
      && fs.existsSync(path.join(PLUGINS_DIR, d, "plugin.js"));
  });
  const entries = [];
  for (const d of dirs) {
    const dir = path.join(PLUGINS_DIR, d);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
    const pluginSrc = fs.readFileSync(path.join(dir, "plugin.js"), "utf8");
    // Bundle: cs3compat header + provider code.
    const bundled =
      "/* ===== cs3compat.js (bundled by build.js) ===== */\n" +
      libSrc +
      "\n/* ===== end cs3compat.js ===== */\n\n" +
      pluginSrc;
    entries.push({ dir: dir, manifest: manifest, bundled: bundled });
  }
  return entries;
}

function build() {
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

  // The `url` field in plugins.json MUST be an ABSOLUTE URL (SkyStream does NOT
  // resolve relative URLs against the pluginLists base — see
  // lib/core/extensions/services/repository_service.dart:850 which calls
  // downloadPlugin(plugin.sourceUrl) verbatim).
  //
  // So we need to know the public raw URL where dist/ will be hosted. Read it
  // from either:
  //   - env var SKYSTREAM_REPO_URL (e.g. "https://raw.githubusercontent.com/USER/REPO/main")
  //   - or the file build/.repo-base-url (one line, no trailing slash)
  // If neither is set, emit a RELATIVE url + a loud warning, so the build still
  // works for local testing but is NOT publishable.
  const REPO_BASE_URL = (process.env.SKYSTREAM_REPO_URL || "")
    .replace(/\/+$/, "")
    .trim();
  const usingAbsolute = REPO_BASE_URL.length > 0;
  if (!usingAbsolute) {
    console.warn("WARNING: SKYSTREAM_REPO_URL not set.");
    console.warn("         dist/plugins.json will use RELATIVE urls (NOT publishable to SkyStream).");
    console.warn("         Re-run with: SKYSTREAM_REPO_URL=https://raw.githubusercontent.com/USER/REPO/main node build/build.js");
  } else {
    console.log("Using repo base URL:", REPO_BASE_URL);
  }

  const entries = loadPlugins();
  const pluginsJson = [];
  for (const e of entries) {
    const pkg = e.manifest.packageName;
    if (!pkg) { console.error("Skipping (no packageName):", e.dir); continue; }
    const skyPath = path.join(DIST_DIR, pkg + ".sky");
    const zip = makeZip([
      { name: "plugin.json", data: Buffer.from(JSON.stringify(e.manifest, null, 2), "utf8") },
      { name: "plugin.js",   data: Buffer.from(e.bundled, "utf8") },
    ]);
    fs.writeFileSync(skyPath, zip);
    const fileSize = zip.length;

    // The `url` field MUST be absolute (SkyStream downloads it verbatim, no
    // relativization against the pluginLists base URL).
    const relativeUrl = "dist/" + pkg + ".sky";
    const absoluteUrl = usingAbsolute ? (REPO_BASE_URL + "/" + relativeUrl) : relativeUrl;

    const entry = {
      packageName: pkg,
      name: e.manifest.name,
      version: e.manifest.version || 1,
      baseUrl: e.manifest.baseUrl || "",
      description: e.manifest.description || "",
      authors: e.manifest.authors || [],
      languages: e.manifest.languages || [],
      categories: e.manifest.categories || [],
      url: absoluteUrl,
      fileSize: fileSize,
      status: 1,
      repositoryUrl: REPO_BASE_URL || "",
    };
    pluginsJson.push(entry);
    console.log("  built", pkg + ".sky", "(" + fileSize + " bytes)  url=" + absoluteUrl);
  }

  // NOTE: We emit ONLY the ported providers. No pending placeholders.
  // (Previous versions merged build/all-providers-catalog.json to list all 39
  // 3arabi providers as status=0 placeholders; that was removed because the
  //  user only wants the 4 working providers shipped.)

  fs.writeFileSync(
    path.join(DIST_DIR, "plugins.json"),
    JSON.stringify(pluginsJson, null, 2)
  );
  console.log("\nWrote dist/plugins.json with", pluginsJson.length, "entries (all ported, all status=1)");

  // Also (re)write repo.json so its pluginLists URL matches REPO_BASE_URL.
  // This keeps repo.json + plugins.json in sync — you commit both after a build.
  if (usingAbsolute) {
    const repoJson = {
      name: "3arabi for SkyStream",
      packageName: "dev.arabi.skystream.repo",
      description: "Arabic movies, series & anime providers — ported from CloudStream re-3arabi to SkyStream native JS plugins. Adds 3isk (قصة عشق), Aflaam, Akwam, CimaClub.",
      manifestVersion: 1,
      pluginLists: [ REPO_BASE_URL + "/dist/plugins.json" ],
    };
    fs.writeFileSync(
      path.join(ROOT, "repo.json"),
      JSON.stringify(repoJson, null, 2) + "\n"
    );
    console.log("Wrote repo.json with pluginLists[0] =", repoJson.pluginLists[0]);
  } else {
    console.log("repo.json left unchanged (still has placeholder pluginLists URL).");
  }
}

build();
