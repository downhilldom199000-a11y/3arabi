/*
 * Akwam (ak.sv -> akwam.org auto-redirect) — SkyStream native JS port
 * Original: re-3arabi builds/Akwam.cs3 (CloudStream)
 *
 * Site: https://ak.sv  (auto-updates mainUrl from response redirects)
 *
 * Flow:
 *   getHome  -> 12 sections (movies/series by language: arabic/turkish/asian/foreign/indian + shows)
 *   search   -> /search?q=<urlencoded>
 *   load     -> parse title/poster/plot/year/rating/tags; for series enumerate seasons
 *               (Arabic-ordinal season-name sort map) and episodes
 *   loadStreams -> a.link-show -> GET watchUrl -> source[src,size|label]
 *
 * All media URLs are direct .mp4 (no ExtractorApi, no packer).
 */
(function (global) {
  "use strict";

  var M = (typeof manifest !== "undefined" && manifest) || {};
  var mainUrl = (M.baseUrl || M.customBaseUrl || "https://ak.sv").replace(/\/+$/, "");
  var providerName = M.name || "Akwam";

  // Arabic ordinal season-name -> number map (mirrors original Akwam.kt).
  var ARABIC_SEASON_MAP = {
    "الاول": 1, "الأول": 1, "الثاني": 2, "الثالث": 3, "الرابع": 4, "الخامس": 5,
    "السادس": 6, "السابع": 7, "الثامن": 8, "التاسع": 9, "العاشر": 10,
    "الحادي عشر": 11, "الثاني عشر": 12, "الثالث عشر": 13, "الرابع عشر": 14,
    "الخامس عشر": 15, "السادس عشر": 16, "السابع عشر": 17, "الثامن عشر": 18,
    "التاسع عشر": 19, "العشرون": 20, "الحادي والعشرون": 21, "الثاني والعشرون": 22,
    "الثالث والعشرون": 23, "الرابع والعشرون": 24, "الخامس والعشرون": 25,
    "السادس والعشرون": 26, "السابع والعشرون": 27, "الثامن والعشرون": 28,
    "التاسع والعشرون": 29, "الثلاثون": 30,
  };

  function getSeasonNumber(name) {
    if (!name) return 999;
    var s = name.trim();
    if (ARABIC_SEASON_MAP[s]) return ARABIC_SEASON_MAP[s];
    // try substring match for embedded ordinal
    var keys = Object.keys(ARABIC_SEASON_MAP);
    for (var i = 0; i < keys.length; i++) {
      if (s.indexOf(keys[i]) !== -1) return ARABIC_SEASON_MAP[keys[i]];
    }
    // fallback: last number in the string
    var nums = s.match(/\d+/g);
    return nums && nums.length ? parseInt(nums[nums.length - 1], 10) : 999;
  }

  function getEpisodeNumber(s) {
    var nums = (s || "").match(/\d+/g);
    return nums && nums.length ? parseInt(nums[nums.length - 1], 10) : null;
  }

  // CloudStream Qualities mapping
  function qualityFromName(name) {
    var n = (name || "").toLowerCase();
    if (n.indexOf("4k") !== -1 || n.indexOf("2160") !== -1) return 2160;
    if (n.indexOf("1080") !== -1 || n.indexOf("fhd") !== -1) return 1080;
    if (n.indexOf("720") !== -1 || n.indexOf("hd") !== -1) return 720;
    if (n.indexOf("480") !== -1 || n.indexOf("sd") !== -1) return 480;
    if (n.indexOf("360") !== -1) return 360;
    return 0; // Unknown
  }

  // ---------- regex helpers ----------
  function firstMatch(re, s) { var m = s && s.match(re); return m ? m[1] : ""; }
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

  function findBlock(html, openTagRegex) {
    var m = html.match(openTagRegex);
    if (!m) return null;
    var tag = (m[0].match(/^<([a-zA-Z0-9]+)/) || [])[1] || "div";
    var startIdx = m.index;
    var openEnd = m.index + m[0].length;
    var depth = 1, cm;
    var depthRe = new RegExp("<(/?)" + tag + "\\b[^>]*>", "gi");
    depthRe.lastIndex = openEnd;
    while ((cm = depthRe.exec(html)) !== null) {
      if (cm[1] === "/") depth--;
      else depth++;
      if (depth === 0) {
        return { open: m[0], inner: html.substring(openEnd, cm.index), full: html.substring(startIdx, cm.index + cm[0].length) };
      }
    }
    return { open: m[0], inner: html.substring(openEnd), full: html.substring(startIdx) };
  }

  function findAllBlocks(html, openTagRegex) {
    var out = [];
    var re = new RegExp(openTagRegex.source, openTagRegex.flags.replace("g", "") + "g");
    var m;
    while ((m = re.exec(html)) !== null) {
      var tag = (m[0].match(/^<([a-zA-Z0-9]+)/) || [])[1] || "div";
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
      out.push({ open: m[0], inner: html.substring(openEnd, endIdx), full: html.substring(startIdx, endIdx) });
      re.lastIndex = endIdx;
    }
    return out;
  }

  function attrVal(tagStr, name) {
    var m = tagStr.match(new RegExp("\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=\\s*[\"']([^\"']*)[\"']"));
    return m ? m[1] : "";
  }

  function autoUpdateMainUrl(finalUrl) {
    if (!finalUrl) return;
    var m = finalUrl.match(/^(https?:\/\/[^/]+)/i);
    if (m && m[1] !== mainUrl) mainUrl = m[1].replace(/\/+$/, "");
  }

  // ---------- item parsing (div.col-lg-auto.col-md-4.col-6) ----------
  function parseItem(itemHtml) {
    if (!itemHtml) return null;
    var aM = itemHtml.match(/<a\b([^>]*)>/i);
    if (!aM) return null;
    var href = attrVal(aM[1], "href");
    if (!href) return null;
    href = abs(href, mainUrl);
    // title h3.entry-title a (or h3.entry-title text)
    var titleM = itemHtml.match(/<h3\b[^>]*\bclass\s*=\s*["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i);
    var title = stripTags(titleM ? titleM[1] : "");
    // poster img data-src|src
    var imgM = itemHtml.match(/<img\b[^>]*\bdata-src\s*=\s*["']([^"']+)["']/i)
      || itemHtml.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    var poster = imgM ? abs(imgM[1], mainUrl) : "";
    // encode poster in URL hash so load() can recover it (mirrors original Akwam behavior)
    var itemUrl = href + (poster ? "#" + poster : "");
    // type decision: search results always Movie; home: based on href
    var type = "movie";
    if (href.indexOf("/series/") !== -1) type = "tvseries";
    return new MultimediaItem({ url: itemUrl, title: title || "Untitled", posterUrl: poster, type: type });
  }

  // ---------- getHome ----------
  var HOME_SECTIONS = [
    { path: "/movies", title: "أحدث الأفلام" },
    { path: "/series", title: "أحدث المسلسلات" },
    { path: "/shows", title: "العروض" },
    { path: "/series?section=29&category=0&rating=0&year=0&language=0&formats=0&quality=0", title: "مسلسلات عربي" },
    { path: "/series?section=32&category=0&rating=0&year=0&language=0&formats=0&quality=0", title: "مسلسلات تركي" },
    { path: "/series?section=33&category=0&rating=0&year=0&language=0&formats=0&quality=0", title: "مسلسلات اسيوية" },
    { path: "/series?section=30&category=0&rating=0&year=0&language=0&formats=0&quality=0", title: "مسلسلات اجنبي" },
    { path: "/series?section=31&category=0&rating=0&year=0&language=0&formats=0&quality=0", title: "مسلسلات هندي" },
    { path: "/movies?section=29&category=0&rating=0&year=0&language=0&formats=0&quality=0", title: "أفلام عربي" },
    { path: "/movies?section=32&category=0&rating=0&year=0&language=0&formats=0&quality=0", title: "أفلام تركي" },
    { path: "/movies?section=33&category=0&rating=0&year=0&language=0&formats=0&quality=0", title: "أفلام اسيوية" },
    { path: "/movies?section=30&category=0&rating=0&year=0&language=0&formats=0&quality=0", title: "أفلام اجنبي" },
  ];

  function getHome(cb) {
    var result = {};
    Promise.all(HOME_SECTIONS.map(function (sec) {
      var url = mainUrl.replace(/\/+$/, "") + "/" + sec.path.replace(/^\/+/, "");
      return app.get(url, { "Referer": mainUrl }, mainUrl).then(function (r) {
        if (r && r.finalUrl) autoUpdateMainUrl(r.finalUrl);
        var items = [];
        if (r && r.text) {
          var blocks = findAllBlocks(r.text, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bcol-lg-auto\b[^"']*\bcol-md-4\b[^"']*\bcol-6\b[^"']*["']/i);
          for (var i = 0; i < blocks.length; i++) {
            var it = parseItem(blocks[i].full);
            if (it) items.push(it);
          }
        }
        return { name: sec.title, items: items };
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
    var url = mainUrl + "/search?q=" + encodeURIComponent(query);
    app.get(url, { "Referer": mainUrl }, mainUrl)
      .then(function (r) {
        if (r && r.finalUrl) autoUpdateMainUrl(r.finalUrl);
        var items = [];
        if (r && r.text) {
          var blocks = findAllBlocks(r.text, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bcol-lg-auto\b[^"']*\bcol-md-4\b[^"']*\bcol-6\b[^"']*["']/i);
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
    var parts = url.split("#");
    var pageUrl = parts[0];
    var encodedPoster = parts[1] || "";
    app.get(pageUrl, { "Referer": mainUrl }, mainUrl)
      .then(function (r) {
        if (!r || !r.text) { cb({ success: false, errorCode: "LOAD_ERROR", message: "empty" }); return; }
        if (r.finalUrl) autoUpdateMainUrl(r.finalUrl);
        var html = r.text;
        var title = stripTags(firstMatch(/<h1\b[^>]*\bclass\s*=\s*["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i, html));
        var poster = encodedPoster;
        if (!poster) {
          var pm = html.match(/<img\b[^>]*\bdata-src\s*=\s*["']([^"']+)["']/i) || html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
          if (pm) poster = abs(pm[1], pageUrl);
        }
        // plot: h2 containing قصة المسلسل then sibling div > p, else meta description
        var plot = "";
        var h2m = html.match(/<h2\b[^>]*>([\s\S]*?قصة المسلسل[\s\S]*?)<\/h2>/i);
        if (h2m) {
          var after = html.substring(html.indexOf(h2m[0]) + h2m[0].length);
          var divM = after.match(/<div\b[^>]*>([\s\S]*?)<\/div>/i);
          var pM = divM ? divM[1].match(/<p\b[^>]*>([\s\S]*?)<\/p>/i) : null;
          plot = stripTags(pM ? pM[1] : "");
        }
        if (!plot) {
          var metaM = html.match(/<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i);
          plot = metaM ? metaM[1] : "";
        }
        // rating span.mx-2 containing '/'
        var rating = 0;
        var ratingRe = /<span\b[^>]*\bclass\s*=\s*["'][^"']*\bmx-2\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
        var rm;
        while ((rm = ratingRe.exec(html)) !== null) {
          var t = stripTags(rm[1]);
          if (t.indexOf("/") !== -1) {
            var afterSlash = t.split("/").pop().trim();
            rating = parseFloat(afterSlash) || 0;
            if (rating) break;
          }
        }
        // tags: a[href*='/genre/'] or a[href*='/category/']
        var tags = [];
        var tagRe = /<a\b[^>]*\bhref\s*=\s*["'][^"']*(?:\/genre\/|\/category\/)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
        var tm;
        while ((tm = tagRe.exec(html)) !== null) tags.push(stripTags(tm[1]));
        // year: a[href*='/year/']
        var year = 0;
        var yearM = html.match(/<a\b[^>]*\bhref\s*=\s*["'][^"']*\/year\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
        if (yearM) {
          var yn = stripTags(yearM[1]).match(/\d{4}/);
          if (yn) year = parseInt(yn[0], 10);
        }

        // seasons: div.widget-body > a.btn[href*='/series/']
        var seasons = [];
        var wb = findBlock(html, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bwidget-body\b[^"']*["']/i);
        var seasonsHost = wb ? wb.inner : html;
        var seasonRe = /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bbtn\b[^"']*["'][^>]*\bhref\s*=\s*["']([^"']*\/series\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
        var sm;
        while ((sm = seasonRe.exec(seasonsHost)) !== null) {
          var sUrl = abs(sm[1], pageUrl);
          var sName = stripTags(sm[2]);
          seasons.push({ url: sUrl, name: sName, num: getSeasonNumber(sName) });
        }
        // dedupe seasons by url
        var seenSeason = {};
        seasons = seasons.filter(function (s) {
          if (seenSeason[s.url]) return false;
          seenSeason[s.url] = true;
          return true;
        });
        seasons.sort(function (a, b) { return a.num - b.num; });

        // direct episodes check: div#series-episodes div[class*='col-']
        var seriesEpBlock = findBlock(html, /<div\b[^>]*\bid\s*=\s*["']series-episodes["']/i);
        var directEpisodes = [];
        if (seriesEpBlock) {
          var epCols = findAllBlocks(seriesEpBlock.inner, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bcol-(?:lg-4|md-6)\b/i);
          for (var i = 0; i < epCols.length; i++) {
            var ec = epCols[i];
            var epLinkM = ec.inner.match(/<a\b[^>]*\bhref\s*=\s*["']([^"']*\/episode\/[^"']*)["']/i);
            if (!epLinkM) continue;
            var epUrl = abs(epLinkM[1], pageUrl);
            var epNameM = ec.inner.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
            var epName = epNameM ? stripTags(epNameM[1]) : stripTags(epLinkM[1]);
            var epThumbM = ec.inner.match(/<img\b[^>]*\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i);
            var epPoster = epThumbM ? abs(epThumbM[1], pageUrl) : poster;
            var epNum = getEpisodeNumber(epName) || (i + 1);
            directEpisodes.push(new Episode({
              name: epName || ("Episode " + epNum), url: epUrl, season: 1, episode: epNum,
              posterUrl: epPoster, description: "",
            }));
          }
        }

        var isSeries = seasons.length > 1 || directEpisodes.length > 0;
        var episodes = [];
        if (isSeries) {
          // if we have multiple seasons, we'd need to fetch each; for now use direct episodes
          // (single-page season listing). If direct episodes exist, use them; else mark placeholder.
          episodes = directEpisodes.slice();
          // If multiple seasons and no direct episodes, fetch each season page.
          if (!episodes.length && seasons.length) {
            // fetch first 5 seasons to populate episodes (best-effort; the original
            // fetches all seasons sequentially).
            return Promise.all(seasons.slice(0, 6).map(function (s, idx) {
              return app.get(s.url, { "Referer": pageUrl }, pageUrl).then(function (sr) {
                if (!sr || !sr.text) return [];
                var sBlock = findBlock(sr.text, /<div\b[^>]*\bid\s*=\s*["']series-episodes["']/i);
                if (!sBlock) return [];
                var cols = findAllBlocks(sBlock.inner, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bcol-(?:lg-4|md-6)\b/i);
                var eps = [];
                for (var i = 0; i < cols.length; i++) {
                  var em = cols[i].inner.match(/<a\b[^>]*\bhref\s*=\s*["']([^"']*\/episode\/[^"']*)["']/i);
                  if (!em) continue;
                  var eUrl = abs(em[1], s.url);
                  var eNameM = cols[i].inner.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
                  var eName = eNameM ? stripTags(eNameM[1]) : stripTags(em[1]);
                  var eThumbM = cols[i].inner.match(/<img\b[^>]*\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i);
                  var ePoster = eThumbM ? abs(eThumbM[1], s.url) : poster;
                  var eNum = getEpisodeNumber(eName) || (i + 1);
                  eps.push(new Episode({
                    name: eName || ("Episode " + eNum), url: eUrl,
                    season: s.num, episode: eNum, posterUrl: ePoster, description: "",
                  }));
                }
                return eps;
              }).catch(function () { return []; });
            })).then(function (allEps) {
              for (var i = 0; i < allEps.length; i++) {
                for (var j = 0; j < allEps[i].length; j++) episodes.push(allEps[i][j]);
              }
              episodes.sort(function (a, b) {
                if (a.season !== b.season) return a.season - b.season;
                return a.episode - b.episode;
              });
              finishLoad();
            });
            return;
          }
          episodes.sort(function (a, b) {
            if (a.season !== b.season) return a.season - b.season;
            return a.episode - b.episode;
          });
        }

        finishLoad();
        function finishLoad() {
          var item = new MultimediaItem({
            url: pageUrl, title: title || "Unknown", posterUrl: poster,
            type: isSeries ? "tvseries" : "movie",
            description: plot, year: year, score: rating, tags: tags,
            episodes: episodes, recommendations: [],
          });
          cb({ success: true, data: item });
        }
      })
      .catch(function (e) { cb({ success: false, errorCode: "LOAD_ERROR", message: String(e && (e.stack || e)) }); });
  }

  // ---------- loadStreams ----------
  function loadStreams(url, cb) {
    var headersBase = { "User-Agent": cs3compat.DEFAULT_UA, "Referer": url };
    app.get(url, headersBase, url)
      .then(function (r) {
        if (!r || !r.text) { cb({ success: false, errorCode: "STREAM_ERROR", message: "empty" }); return; }
        var html = r.text;
        // find a.link-show href -> build watchUrl
        var watchUrl = "";
        var watchM = html.match(/<a\b[^>]*\bclass\s*=\s*["'][^"']*\blink-show\b[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i);
        if (watchM) {
          watchUrl = abs(watchM[1], mainUrl);
        }
        if (!watchUrl) {
          // fallback: direct media URLs
          var direct = extractMediaUrls(html).concat(analyzeAndSaveEvalScripts(html));
          var out0 = direct.map(function (u) {
            return new StreamResult({ url: u, source: providerName + " Auto", headers: { "Referer": url } });
          });
          cb({ success: true, data: out0 });
          return;
        }
        // GET watchUrl with Referer = data (the episode URL)
        app.get(watchUrl, headersBase, url).then(function (r2) {
          var streams = [];
          if (!r2 || !r2.text) { cb({ success: true, data: [] }); return; }
          var t = r2.text;
          // <source src=... size|label=...>
          var srcRe = /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']([^>]*)>/gi;
          var sm;
          while ((sm = srcRe.exec(t)) !== null) {
            var srcUrl = abs(sm[1], watchUrl);
            var rest = sm[2] || "";
            var sizeM = rest.match(/\bsize\s*=\s*["']([^"']+)["']/i);
            var labelM = rest.match(/\blabel\s*=\s*["']([^"']+)["']/i);
            var qLabel = (sizeM ? sizeM[1] : "") || (labelM ? labelM[1] : "") || "Auto";
            streams.push(new StreamResult({
              url: srcUrl, source: providerName + " " + qLabel, headers: { "Referer": watchUrl },
            }));
          }
          if (!streams.length) {
            extractMediaUrls(t).forEach(function (u) {
              streams.push(new StreamResult({ url: u, source: providerName + " Auto", headers: { "Referer": watchUrl } }));
            });
          }
          cb({ success: true, data: streams });
        }).catch(function (e) { cb({ success: false, errorCode: "STREAM_ERROR", message: String(e && (e.stack || e)) }); });
      })
      .catch(function (e) { cb({ success: false, errorCode: "STREAM_ERROR", message: String(e && (e.stack || e)) }); });
  }

  global.getHome = getHome;
  global.search = search;
  global.load = load;
  global.loadStreams = loadStreams;
})(globalThis);
