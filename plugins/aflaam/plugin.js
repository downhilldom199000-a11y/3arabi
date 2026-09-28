/*
 * Aflaam (aflaam.com) — SkyStream native JS port
 * Original: re-3arabi builds/Aflaam.cs3 (CloudStream)
 *
 * Site: https://aflaam.com  (Arabic movies & series)
 *
 * Flow:
 *   getHome  -> 4 sections (foreign/arabic/indian movies + series) via /search?section=N
 *   search   -> /search?q=<query>
 *   load     -> parse title/poster/plot/year/rating/tags; for series build episodes
 *   loadStreams -> div.qualities a.link-show -> for each: GET watchUrl -> video#player source[src,size]
 *
 * All media URLs are direct .mp4 (no ExtractorApi, no packer, no WebView).
 */
(function (global) {
  "use strict";

  var M = (typeof manifest !== "undefined" && manifest) || {};
  var mainUrl = (M.baseUrl || M.customBaseUrl || "https://aflaam.com").replace(/\/+$/, "");
  var providerName = M.name || "Aflaam";

  // ---------- small regex helpers ----------
  function firstMatch(re, s) { var m = s && s.match(re); return m ? m[1] : ""; }
  function allMatches(re, s) {
    var out = [], m; re.lastIndex = 0;
    while ((m = re.exec(s)) !== null) out.push(m);
    return out;
  }
  function stripTags(s) {
    return (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  }
  function abs(u, base) {
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("//")) return "https:" + u;
    if (u.startsWith("/")) { var m = base.match(/^(https?:\/\/[^/]+)/); return m ? m[1] + u : u; }
    var m2 = base.match(/^(https?:\/\/[^/]+\/)/); return m2 ? m2[1] + u : u;
  }

  // Find the inner HTML of the first <tag ...>...</tag> block whose opening tag
  // matches `openTagRegex`. Returns {open, inner, close, full} or null.
  function findBlock(html, openTagRegex) {
    var m = html.match(openTagRegex);
    if (!m) return null;
    var tag = m[1] || m[0].match(/^<([a-zA-Z0-9]+)/)[1];
    var startIdx = m.index;
    var openEnd = m.index + m[0].length;
    var depth = 1, cm;
    var depthRe = new RegExp("<(/?)" + tag + "\\b[^>]*>", "gi");
    depthRe.lastIndex = openEnd;
    while ((cm = depthRe.exec(html)) !== null) {
      if (cm[1] === "/") depth--;
      else depth++;
      if (depth === 0) {
        return {
          open: m[0], openEnd: openEnd,
          inner: html.substring(openEnd, cm.index),
          full: html.substring(startIdx, cm.index + cm[0].length),
        };
      }
    }
    return { open: m[0], openEnd: openEnd, inner: html.substring(openEnd), full: html.substring(startIdx) };
  }

  // Find ALL top-level <div class="...">...</div> blocks whose opening tag matches.
  function findAllBlocks(html, openTagRegex) {
    var out = [];
    var re = new RegExp(openTagRegex.source, openTagRegex.flags.replace("g", "") + "g");
    var m;
    while ((m = re.exec(html)) !== null) {
      var tag = (m[1] || (m[0].match(/^<([a-zA-Z0-9]+)/) || [])[1] || "div");
      var startIdx = m.index;
      var openEnd = m.index + m[0].length;
      var depth = 1, cm;
      var depthRe = new RegExp("<(/?)" + tag + "\\b[^>]*>", "gi");
      depthRe.lastIndex = openEnd;
      var endIdx = html.length;
      while ((cm = depthRe.exec(html)) !== null) {
        if (cm[1] === "/") depth--;
        else depth++;
        if (depth === 0) { endIdx = cm.index + cm[0].length; break; }
      }
      out.push({
        open: m[0], inner: html.substring(openEnd, endIdx), full: html.substring(startIdx, endIdx),
      });
      re.lastIndex = endIdx;
    }
    return out;
  }

  // ---------- item parsing (div.item) ----------
  function parseItem(itemHtml) {
    if (!itemHtml) return null;
    // link a.box href
    var linkM = itemHtml.match(/<a\b[^>]*\bclass\s*=\s*["'][^"']*\bbox\b[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i)
      || itemHtml.match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\bclass\s*=\s*["'][^"']*\bbox\b/i);
    if (!linkM) return null;
    var href = abs(linkM[1], mainUrl);
    // title h3.entry-title
    var titleM = itemHtml.match(/<h3\b[^>]*\bclass\s*=\s*["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i);
    var title = stripTags(titleM ? titleM[1] : "");
    // poster picture > img src
    var imgM = itemHtml.match(/<picture\b[\s\S]*?<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)
      || itemHtml.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    var poster = imgM ? abs(imgM[1], mainUrl) : "";
    // type decision
    var type;
    if (href.indexOf("/movie/") !== -1) type = "movie";
    else if (href.indexOf("/series/") !== -1) type = "tvseries";
    else return null;
    return new MultimediaItem({ url: href, title: title || "Untitled", posterUrl: poster, type: type });
  }

  // ---------- getHome ----------
  function getHome(cb) {
    var sections = [
      { url: mainUrl + "/search?section=2", name: "Foreign Movies" },
      { url: mainUrl + "/search?section=1", name: "Arabic Movies" },
      { url: mainUrl + "/search?section=3", name: "Indian Movies" },
      { url: mainUrl + "/series", name: "Series" },
    ];
    var result = {};
    Promise.all(sections.map(function (sec) {
      return app.get(sec.url, { "Referer": mainUrl }, mainUrl).then(function (r) {
        var items = [];
        if (r && r.text) {
          var blocks = findAllBlocks(r.text, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bitem\b[^"']*["']/i);
          for (var i = 0; i < blocks.length; i++) {
            var it = parseItem(blocks[i].full);
            if (it) items.push(it);
          }
        }
        return { name: sec.name, items: items };
      });
    }))
      .then(function (all) {
        for (var i = 0; i < all.length; i++) {
          if (all[i].items.length) result[all[i].name] = all[i].items;
        }
        cb({ success: true, data: result });
      })
      .catch(function (e) { cb({ success: false, errorCode: "SITE_OFFLINE", message: String(e) }); });
  }

  // ---------- search ----------
  function search(query, page, cb) {
    var url = mainUrl + "/search?q=" + query;
    app.get(url, { "Referer": mainUrl }, mainUrl)
      .then(function (r) {
        var items = [];
        if (r && r.text) {
          var blocks = findAllBlocks(r.text, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bitem\b[^"']*["']/i);
          for (var i = 0; i < blocks.length; i++) {
            var it = parseItem(blocks[i].full);
            if (it) items.push(it);
          }
        }
        cb({ success: true, data: items });
      })
      .catch(function (e) { cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e) }); });
  }

  // ---------- load ----------
  function load(url, cb) {
    app.get(url, { "Referer": mainUrl }, mainUrl)
      .then(function (r) {
        if (!r || !r.text) { cb({ success: false, errorCode: "LOAD_ERROR", message: "empty" }); return; }
        var html = r.text;
        var title = stripTags(firstMatch(/<h1\b[^>]*\bclass\s*=\s*["'][^"']*\bfont-size-44\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i, html) || "");
        var posterM = html.match(/<a\b[^>]*\bclass\s*=\s*["'][^"']*\bmovie-poster\b[^"']*["'][\s\S]*?<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
        var poster = posterM ? abs(posterM[1], url) : "";
        // plot
        var plotBlock = findBlock(html, /<div\b[^>]*\bid\s*=\s*["']movie-tab-2["']/i);
        var plot = "";
        if (plotBlock) {
          var wb = findBlock(plotBlock.inner, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bwidget-body\b/i);
          var pM = (wb ? wb.inner : plotBlock.inner).match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
          plot = stripTags(pM ? pM[1] : "");
        }
        // year
        var year = 0;
        var mc = findBlock(html, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bmovie-container\b/i);
        if (mc) {
          var flex = findBlock(mc.inner, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bd-flex\b/i);
          if (flex) {
            var ym = flex.inner.match(/سنة الإنتاج\s*[:：]?\s*(\d{4})/);
            if (ym) year = parseInt(ym[1], 10);
          }
        }
        // rating
        var ratingM = html.match(/<span\b[^>]*\bclass\s*=\s*["'][^"']*\bfont-size-24\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
        var score = ratingM ? (parseFloat(stripTags(ratingM[1])) || 0) : 0;
        // tags
        var tags = [];
        var tagRe = /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bmovie-category\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
        var tm; while ((tm = tagRe.exec(html)) !== null) tags.push(stripTags(tm[1]));

        var isSeries = url.indexOf("/series/") !== -1;
        var episodes = [];
        if (isSeries) {
          // episodes container: div#movie-tab-1 -> div.entry-box-3 each
          var tab1 = findBlock(html, /<div\b[^>]*\bid\s*=\s*["']movie-tab-1["']/i);
          if (tab1) {
            var eb3 = findAllBlocks(tab1.inner, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bentry-box-3\b/i);
            for (var i = 0; i < eb3.length; i++) {
              var eb = eb3[i];
              var aM = eb.inner.match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i);
              if (!aM) continue;
              var epUrl = abs(aM[1], url);
              var epTitleM = eb.inner.match(/<h3\b[^>]*\bclass\s*=\s*["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i);
              var epName = stripTags(epTitleM ? epTitleM[1] : "").replace(/^\d+\s*/, "");
              var epNumM = eb.inner.match(/<span\b[^>]*\bclass\s*=\s*["'][^"']*\bfont-size-50\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
              var epNum = epNumM ? (parseInt(stripTags(epNumM[1]).match(/\d+/), 10) || (i + 1)) : (i + 1);
              var epThumbM = eb.inner.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
              var epPoster = epThumbM ? abs(epThumbM[1], url) : poster;
              episodes.push(new Episode({
                name: epName || ("Episode " + epNum), url: epUrl, season: 1, episode: epNum,
                posterUrl: epPoster, description: "",
              }));
            }
            // original reverses episode order
            episodes.reverse();
          }
        }

        var item = new MultimediaItem({
          url: url, title: title || "Unknown", posterUrl: poster,
          type: isSeries ? "tvseries" : "movie",
          description: plot, year: year, score: score, tags: tags,
          episodes: episodes, recommendations: [],
        });
        cb({ success: true, data: item });
      })
      .catch(function (e) { cb({ success: false, errorCode: "LOAD_ERROR", message: String(e && (e.stack || e)) }); });
  }

  // ---------- loadStreams ----------
  function loadStreams(url, cb) {
    var headersBase = { "User-Agent": cs3compat.DEFAULT_UA, "Referer": mainUrl };
    app.get(url, headersBase, mainUrl)
      .then(function (r) {
        if (!r || !r.text) { cb({ success: false, errorCode: "STREAM_ERROR", message: "empty" }); return; }
        var html = r.text;
        // find all watch links: div.qualities a.link-show
        var watchLinks = [];
        var re = /<a\b[^>]*\bclass\s*=\s*["'][^"']*\blink-show\b[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
        var m;
        while ((m = re.exec(html)) !== null) watchLinks.push(abs(m[1], url));
        // also fallback: any a.link-show
        if (!watchLinks.length) {
          re = /<a\b[^>]*\bclass\s*=\s*["'][^"']*\blink-show\b[^"']*["'][^>]*>/gi;
          // extract hrefs from those
        }

        if (!watchLinks.length) {
          // maybe direct media URLs already on page
          var direct = extractMediaUrls(html);
          var streams = direct.map(function (u) {
            return new StreamResult({ url: u, source: providerName + " Auto", headers: { "Referer": mainUrl } });
          });
          cb({ success: true, data: streams });
          return;
        }

        // For each watch link, GET it and extract <video#player source[src,size]>
        Promise.all(watchLinks.map(function (wl) {
          return app.get(wl, headersBase, url).then(function (r2) {
            var streams = [];
            if (!r2 || !r2.text) return streams;
            var t = r2.text;
            // find video#player block, then <source> tags inside
            var playerBlock = findBlock(t, /<video\b[^>]*\bid\s*=\s*["']player["']/i);
            var searchIn = playerBlock ? playerBlock.inner : t;
            var srcRe = /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']([^>]*)>/gi;
            var sm;
            while ((sm = srcRe.exec(searchIn)) !== null) {
              var srcUrl = abs(sm[1], wl);
              var rest = sm[2] || "";
              var sizeM = rest.match(/\bsize\s*=\s*["']([^"']+)["']/i);
              var labelM = rest.match(/\blabel\s*=\s*["']([^"']+)["']/i);
              var qLabel = (sizeM ? sizeM[1] : "") || (labelM ? labelM[1] : "") || "Auto";
              streams.push({
                url: srcUrl, source: providerName + " " + qLabel,
                headers: { "Referer": wl },
              });
            }
            // also direct media URLs in case no <source>
            if (!streams.length) {
              extractMediaUrls(t).forEach(function (u) {
                streams.push({ url: u, source: providerName + " Auto", headers: { "Referer": wl } });
              });
            }
            return streams;
          });
        })).then(function (all) {
          var out = [];
          var seen = {};
          for (var i = 0; i < all.length; i++) {
            for (var j = 0; j < all[i].length; j++) {
              var s = all[i][j];
              if (!seen[s.url]) { seen[s.url] = true; out.push(new StreamResult(s)); }
            }
          }
          cb({ success: true, data: out });
        });
      })
      .catch(function (e) { cb({ success: false, errorCode: "STREAM_ERROR", message: String(e && (e.stack || e)) }); });
  }

  global.getHome = getHome;
  global.search = search;
  global.load = load;
  global.loadStreams = loadStreams;
})(globalThis);
