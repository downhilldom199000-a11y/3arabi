/*
 * cs3compat.js — shared compatibility helpers for porting CloudStream "3arabi"
 * providers to SkyStream's native JavaScript plugin runtime.
 *
 * This file is concatenated in front of each provider's plugin.js by the
 * build script (build/build.js) and shipped inside the resulting .sky package.
 *
 * SkyStream's JS runtime (QuickJS-NG via flutter_js_ng) already exposes:
 *   - http_get(url, headers, cb) / http_post(url, headers, body, cb)  -> Promise<HttpResponse>
 *   - atob() / btoa()
 *   - MultimediaItem / Episode / StreamResult constructors
 *   - a `manifest` global containing the plugin.json fields
 *
 * What cs3compat adds (things SkyStream has NO native equivalent for, but the
 * original CloudStream Kotlin providers relied on):
 *   - app.get / app.post            (CloudStream `app.get()` ergonomics)
 *   - decodeBase64Compat            (multi-flag base64 fallback, mirrors 3isk)
 *   - unpackPacker                  (Dean Edwards `eval(function(p,a,c,k,e,d)...)` unpacker)
 *   - analyzeAndSaveEvalScripts     (find packers in <script> tags, unpack, extract media URLs)
 *   - extractMediaUrls              (regex for direct .mp4/.m3u8/.webm/.mov)
 *   - getAllIframeSrcs              (regex for <iframe src="...">)
 *   - newMovieLoadResponse / newTvSeriesLoadResponse (CloudStream-flavored helpers)
 *
 * Everything is synchronous where possible (regex-based) to keep provider
 * code readable; HTTP is async because SkyStream's http_get is Promise-based.
 */
(function (global) {
  "use strict";

  var DEFAULT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // ---------- HTTP wrappers ----------
  function _mergeHeaders(headers, referer) {
    var h = {};
    if (headers && typeof headers === "object") {
      Object.keys(headers).forEach(function (k) { h[k] = headers[k]; });
    }
    if (!h["User-Agent"] && !h["user-agent"]) h["User-Agent"] = DEFAULT_UA;
    if (referer && !h["Referer"] && !h["referer"]) h["Referer"] = referer;
    if (!h["Accept"]) h["Accept"] = "text/html,application/json,*/*;q=0.8";
    return h;
  }

  function _resp(r, fallbackUrl) {
    if (!r) return { text: "", code: 0, finalUrl: fallbackUrl, headers: {}, error: "no response" };
    return {
      text: r.body != null ? String(r.body) : "",
      code: r.statusCode != null ? r.statusCode : (r.code != null ? r.code : 0),
      finalUrl: r.finalUrl || fallbackUrl,
      headers: r.headers || {},
    };
  }

  function httpGet(url, headers, referer) {
    return Promise.resolve()
      .then(function () { return http_get(url, _mergeHeaders(headers, referer)); })
      .then(function (r) { return _resp(r, url); })
      .catch(function (e) { return { text: "", code: 0, finalUrl: url, headers: {}, error: String(e) }; });
  }

  function httpPost(url, headers, body, referer) {
    return Promise.resolve()
      .then(function () { return http_post(url, _mergeHeaders(headers, referer), body || ""); })
      .then(function (r) { return _resp(r, url); })
      .catch(function (e) { return { text: "", code: 0, finalUrl: url, headers: {}, error: String(e) }; });
  }

  // CloudStream `app` ergonomics — `app.get(url, headers, referer)` mirrors
  // CloudStream's `app.get(url, headers, referer = mainUrl)`.
  var app = {
    get: function (url, headers, referer) { return httpGet(url, headers, referer); },
    post: function (url, headers, body, referer) { return httpPost(url, headers, body, referer); },
  };

  // ---------- Base64 (multi-flag compat) ----------
  // Mirrors 3isk.decodeBase64Compat: try standard, then url-safe, then stripped.
  function decodeBase64Compat(encoded) {
    if (encoded == null) return null;
    var s = String(encoded).trim();
    if (s.length === 0) return null;
    var mod = s.length % 4;
    if (mod !== 0) s += new Array(4 - mod + 1).join("=");
    var tries = [
      function () { return atob(s); },
      function () { return atob(s.replace(/-/g, "+").replace(/_/g, "/")); },
      function () { return atob(s.replace(/[^A-Za-z0-9+/=]/g, "")); },
    ];
    for (var i = 0; i < tries.length; i++) {
      try { return tries[i](); } catch (e) {}
    }
    return null;
  }

  // ---------- Dean Edwards packer unpacker ----------
  // Faithful port of 3isk.unpackPackerFromEval + helpers.
  function _intToBase36(n) {
    if (n === 0) return "0";
    var digits = "0123456789abcdefghijklmnopqrstuvwxyz";
    var s = "";
    while (n > 0) { s = digits[n % 36] + s; n = Math.floor(n / 36); }
    return s;
  }

  function _findMatchingBrace(text, startIdx) {
    if (startIdx < 0 || startIdx >= text.length || text[startIdx] !== "{") return -1;
    var depth = 0, inStr = false, quote = "";
    for (var i = startIdx; i < text.length; i++) {
      var ch = text[i];
      if (inStr) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) inStr = false;
      } else {
        if (ch === '"' || ch === "'" || ch === "`") { inStr = true; quote = ch; }
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) return i; }
      }
    }
    return -1;
  }

  function _jsStringUnescape(s) {
    return s.replace(/\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|\\.|\\n|\\r|\\t/g, function (m) {
      try {
        if (m.length >= 2 && m[0] === "\\" && m[1] === "u" && m.length === 6)
          return String.fromCharCode(parseInt(m.slice(2), 16));
        if (m.length >= 2 && m[0] === "\\" && m[1] === "x" && m.length === 4)
          return String.fromCharCode(parseInt(m.slice(2), 16));
        if (m === "\\n") return "\n";
        if (m === "\\r") return "\r";
        if (m === "\\t") return "\t";
        if (m === "\\'") return "'";
        if (m === '\\"') return '"';
        if (m === "\\\\") return "\\";
        if (m.length < 2 || m[0] !== "\\") return m;
        return m.slice(1);
      } catch (e) { return m; }
    });
  }

  function _parseJsStringAt(text, idxInit) {
    if (idxInit >= text.length) return [null, idxInit];
    var quote = text[idxInit];
    if (quote !== '"' && quote !== "'") return [null, idxInit];
    var idx = idxInit + 1, out = "";
    while (idx < text.length) {
      var ch = text[idx];
      if (ch === "\\") {
        if (idx + 1 < text.length) { out += text.substring(idx, idx + 2); idx += 2; }
        else idx++;
      } else if (ch === quote) {
        return [_jsStringUnescape(out), idx + 1];
      } else { out += ch; idx++; }
    }
    return [null, idx];
  }

  function unpackPacker(evalText) {
    try {
      var sigIdx = evalText.indexOf("function(p,a,c,k,e,d)");
      if (sigIdx === -1) return null;
      // Locate the invocation args (p_string, aNum, cNum, ...) directly via a
      // regex, instead of brace-matching through the function body. The Dean
      // Edwards packer body contains regex literals (/\b/, /^/, /\w+/) which a
      // naive brace/string counter cannot track reliably.
      var rest = evalText.substring(sigIdx);
      // p is the FIRST string literal (after the function def) that is followed
      // by ", <number>, <number>," — i.e. the (p, a, c, ...) call args. The
      // string body allows escaped quotes via (?:\\.|(?!\1).)*?
      var invRe = /(["'])((?:\\.|(?!\1)[\s\S])*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,/;
      var m = rest.match(invRe);
      if (!m) return null;
      var pVal = _jsStringUnescape(m[2]);
      var aVal = parseInt(m[3], 10); // (radix; informational)
      var cVal = parseInt(m[4], 10);
      // Find the k array: it follows the c number + comma. Either a bare string
      // literal 'tok1|tok2|...' OR a 'tok1|tok2|...'.split('|') expression.
      var afterCIdx = sigIdx + rest.indexOf(m[0]) + m[0].length;
      var afterC = evalText.substring(afterCIdx);
      var kList = [];
      var kStrM = afterC.match(/^\s*(["'])((?:\\.|(?!\1)[\s\S])*?)\1/);
      if (kStrM) {
        _jsStringUnescape(kStrM[2]).split("|").forEach(function (t) { kList.push(t); });
      } else {
        var splitM = afterC.match(/^\s*(["'])((?:\\.|(?!\1)[\s\S])*?)\1\s*\.split\s*\(\s*["']\|["']\s*\)/);
        if (splitM) {
          _jsStringUnescape(splitM[2]).split("|").forEach(function (t) { kList.push(t); });
        }
      }
      var p = pVal;
      var idx = cVal - 1;
      while (idx >= 0) {
        var key = _intToBase36(idx);
        if (idx < kList.length && kList[idx] && kList[idx].length > 0) {
          var escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          var re = new RegExp("\\b" + escaped + "\\b", "g");
          p = p.replace(re, kList[idx]);
        }
        idx--;
      }
      return p;
    } catch (e) {
      return null;
    }
  }

  // ---------- Media URL extraction ----------
  var MEDIA_URL_RE = /https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4|webm|mov)(?:[?#][^\s"'<>]*)?/gi;
  function extractMediaUrls(html) {
    var out = [];
    if (!html) return out;
    var m;
    MEDIA_URL_RE.lastIndex = 0;
    while ((m = MEDIA_URL_RE.exec(html)) !== null) out.push(m[0]);
    return out;
  }

  // ---------- Eval-script analysis (find packer, unpack, extract media) ----------
  function analyzeAndSaveEvalScripts(htmlText) {
    var found = [];
    if (!htmlText) return found;
    var scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    var sm;
    while ((sm = scriptRe.exec(htmlText)) !== null) {
      var content = sm[1] || "";
      if (!content || !content.trim()) continue;
      var evalRe = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)\s*\{/g;
      var em;
      while ((em = evalRe.exec(content)) !== null) {
        var start = em.index;
        var sample = content.substring(start, start + 10000);
        var unpacked = unpackPacker(sample);
        if (unpacked) {
          var urls = extractMediaUrls(unpacked);
          for (var u = 0; u < urls.length; u++) found.push(urls[u]);
        }
      }
    }
    return found;
  }

  // ---------- Iframe src extraction ----------
  function getAllIframeSrcs(html) {
    var out = [];
    if (!html) return out;
    var re = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    var m;
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out;
  }

  // ---------- CloudStream-flavored constructors (map onto SkyStream classes) ----------
  function newMovieLoadResponse(opts) {
    return new MultimediaItem({
      url: opts.url,
      title: opts.title || "Unknown",
      posterUrl: opts.posterUrl || "",
      type: "movie",
      description: opts.description || "",
      year: opts.year || 0,
      score: opts.score || 0,
      episodes: opts.episodes || [
        new Episode({ name: "Full Movie", url: opts.url, season: 1, episode: 1 }),
      ],
      recommendations: opts.recommendations || [],
    });
  }

  function newTvSeriesLoadResponse(opts) {
    return new MultimediaItem({
      url: opts.url,
      title: opts.title || "Unknown",
      posterUrl: opts.posterUrl || "",
      type: "tvseries",
      description: opts.description || "",
      year: opts.year || 0,
      score: opts.score || 0,
      episodes: opts.episodes || [],
      recommendations: opts.recommendations || [],
    });
  }

  // ---------- URL helpers ----------
  function absUrl(u, base) {
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("//")) return "https:" + u;
    if (u.startsWith("/")) {
      var m = base.match(/^(https?:\/\/[^/]+)/);
      return m ? m[1] + u : u;
    }
    var m2 = base.match(/^(https?:\/\/[^/]+\/)/);
    return m2 ? m2[1] + u : u;
  }

  function host(u) {
    var m = String(u).match(/^https?:\/\/([^/]+)/i);
    return m ? m[1] : "";
  }

  // ---------- Public API ----------
  global.cs3compat = {
    DEFAULT_UA: DEFAULT_UA,
    httpGet: httpGet,
    httpPost: httpPost,
    app: app,
    decodeBase64Compat: decodeBase64Compat,
    unpackPacker: unpackPacker,
    extractMediaUrls: extractMediaUrls,
    analyzeAndSaveEvalScripts: analyzeAndSaveEvalScripts,
    getAllIframeSrcs: getAllIframeSrcs,
    newMovieLoadResponse: newMovieLoadResponse,
    newTvSeriesLoadResponse: newTvSeriesLoadResponse,
    absUrl: absUrl,
    host: host,
    MEDIA_URL_RE: MEDIA_URL_RE,
  };

  // Also expose app + helpers on globalThis directly for ergonomic port code.
  global.app = app;
  global.unpackPacker = unpackPacker;
  global.decodeBase64Compat = decodeBase64Compat;
  global.extractMediaUrls = extractMediaUrls;
  global.analyzeAndSaveEvalScripts = analyzeAndSaveEvalScripts;
  global.getAllIframeSrcs = getAllIframeSrcs;
  global.absUrl = absUrl;
  global.host = host;
})(globalThis);
