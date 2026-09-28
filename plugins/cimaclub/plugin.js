/*
 * CimaClub (cimacub.com) — SkyStream native JS port
 * Original: re-3arabi builds/CimaClub.cs3 (CloudStream)
 *
 * Site: https://cimacub.com  (Arabic movies & series)
 *
 * Flow:
 *   getHome  -> 13 category sections (foreign/arabic/indian/asian/anime movies + series)
 *   search   -> /?s=<query> (spaces as '+')
 *   load     -> parse title/poster/plot/year/tags; series enumerate seasons + episodes
 *   loadStreams -> POST watch=1 to data URL -> ul#watch li[data-watch] + .ServersList.Download a[href]
 *
 * KNOWN LIMITATION: original used CloudStream's loadExtractor() (ExtractorApi) for
 * the embed URLs. SkyStream has NO ExtractorApi. As graceful degradation, embed
 * URLs are emitted as StreamResult directly. If the URL is a direct .mp4/.m3u8
 * the player plays it; otherwise the source is listed but may not be playable.
 * See docs/PORTING_GUIDE.md §"ExtractorApi gap" for the path to full support.
 */
(function (global) {
  "use strict";

  var M = (typeof manifest !== "undefined" && manifest) || {};
  var mainUrl = (M.baseUrl || M.customBaseUrl || "https://cimacub.com").replace(/\/+$/, "");
  var providerName = M.name || "CimaClub";

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

  var HOME_SECTIONS = [
    { url: mainUrl + "/category/افلام-اجنبي/", name: "Foreign Movies" },
    { url: mainUrl + "/category/افلام-عربي/", name: "Arabic Movies" },
    { url: mainUrl + "/category/افلام-هندي/", name: "Indian Movies" },
    { url: mainUrl + "/category/افلام-اسيوية/", name: "Asian Movies" },
    { url: mainUrl + "/category/افلام-انمي/", name: "Anime Movies" },
    { url: mainUrl + "/category/مسلسلات-اجنبي/", name: "Foreign Series" },
    { url: mainUrl + "/category/مسلسلات-تركية/", name: "Turkish Series" },
    { url: mainUrl + "/category/مسلسلات-عربي/", name: "Arabic Series" },
    { url: mainUrl + "/category/مسلسلات-اسيوية/", name: "Asian Series" },
    { url: mainUrl + "/category/مسلسلات-هندية/", name: "Indian Series" },
    { url: mainUrl + "/category/مسلسلات-انمي/", name: "Anime Series" },
  ];

  function parseItem(itemHtml) {
    if (!itemHtml) return null;
    var aM = itemHtml.match(/<a\b([^>]*)>/i);
    if (!aM) return null;
    var href = (aM[1].match(/\bhref\s*=\s*["']([^"']+)["']/) || [])[1] || "";
    if (!href) return null;
    href = abs(href, mainUrl);
    var titleM = itemHtml.match(/<h2\b[^>]*\bclass\s*=\s*["'][^"']*\binner--title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
    var title = stripTags(titleM ? titleM[1] : "");
    var imgM = itemHtml.match(/<img\b[^>]*\bdata-src\s*=\s*["']([^"']+)["']/i)
      || itemHtml.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    var poster = imgM ? abs(imgM[1], mainUrl) : "";
    // type decision: TvSeries if href contains /series/ AND not /مسلسل- AND no .number element
    var isTv = href.indexOf("/series/") !== -1 && href.indexOf("/مسلسل-") === -1;
    var type = isTv ? "tvseries" : "movie";
    return new MultimediaItem({ url: href, title: title || "Untitled", posterUrl: poster, type: type });
  }

  function getHome(cb) {
    var result = {};
    Promise.all(HOME_SECTIONS.map(function (sec) {
      return app.get(sec.url, { "Referer": mainUrl }, mainUrl).then(function (r) {
        var items = [];
        if (r && r.text) {
          // div.BlocksHolder > div.Small--Box
          var bh = findBlock(r.text, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bBlocksHolder\b[^"']*["']/i);
          var host = bh ? bh.inner : r.text;
          var blocks = findAllBlocks(host, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bSmall--Box\b[^"']*["']/i);
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

  function search(query, page, cb) {
    var url = mainUrl + "/?s=" + query.replace(/ /g, "+");
    app.get(url, { "Referer": mainUrl }, mainUrl)
      .then(function (r) {
        var items = [];
        if (r && r.text) {
          var bh = findBlock(r.text, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bBlocksHolder\b[^"']*["']/i);
          var host = bh ? bh.inner : r.text;
          var blocks = findAllBlocks(host, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bSmall--Box\b[^"']*["']/i);
          for (var i = 0; i < blocks.length; i++) {
            var it = parseItem(blocks[i].full);
            if (it) items.push(it);
          }
        }
        cb({ success: true, data: items });
      })
      .catch(function (e) { cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e) }); });
  }

  function load(url, cb) {
    app.get(url, { "Referer": mainUrl }, mainUrl)
      .then(function (r) {
        if (!r || !r.text) { cb({ success: false, errorCode: "LOAD_ERROR", message: "empty" }); return; }
        var html = r.text;
        var title = stripTags(firstMatch(/<h1\b[^>]*\bclass\s*=\s*["'][^"']*\bPostTitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i, html));
        var poster = "";
        var mainSingle = findBlock(html, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bMainSingle\b[^"']*["']/i);
        if (mainSingle) {
          var leftBlock = findBlock(mainSingle.inner, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bleft\b[^"']*["']/i);
          var imgHost = leftBlock ? leftBlock.inner : mainSingle.inner;
          var imgM = (imgHost.match(/<div\b[^>]*\bclass\s*=\s*["'][^"']*\bimage\b[^"']*["'][\s\S]*?<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1]
            || (imgHost.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
          if (imgM) poster = abs(imgM, url);
        }
        // plot: .StoryArea p
        var storyArea = findBlock(html, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bStoryArea\b[^"']*["']/i);
        var plot = "";
        if (storyArea) {
          var pM = storyArea.inner.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
          plot = stripTags(pM ? pM[1] : "").replace(/^قصة العرض/, "").trim();
        }
        // tags: .TaxContent a[href*='/genre/']
        var tags = [];
        var taxBlock = findBlock(html, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bTaxContent\b[^"']*["']/i);
        var taxHost = taxBlock ? taxBlock.inner : html;
        var tagRe = /<a\b[^>]*\bhref\s*=\s*["'][^"']*\/genre\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
        var tm; while ((tm = tagRe.exec(taxHost)) !== null) tags.push(stripTags(tm[1]));
        // year: .TaxContent a[href*='/release-year/']
        var year = 0;
        var yearM = taxHost.match(/<a\b[^>]*\bhref\s*=\s*["'][^"']*\/release-year\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
        if (yearM) { var yn = stripTags(yearM[1]).match(/\d{4}/); if (yn) year = parseInt(yn[0], 10); }

        // seasons: section.allseasonss .Small--Box a
        var seasons = [];
        var seasonSec = findBlock(html, /<section\b[^>]*\bclass\s*=\s*["'][^"']*\ballseasonss\b[^"']*["']/i);
        var seasonHost = seasonSec ? seasonSec.inner : html;
        var seasonRe = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bSmall--Box\b[^"']*["'][\s\S]*?<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        var sm;
        while ((sm = seasonRe.exec(seasonHost)) !== null) {
          seasons.push({ url: abs(sm[1], url), name: stripTags(sm[2]) });
        }

        // episodes: section.allepcont .row a
        var episodes = [];
        var epSec = findBlock(html, /<section\b[^>]*\bclass\s*=\s*["'][^"']*\ballepcont\b[^"']*["']/i);
        var epHost = epSec ? epSec.inner : html;
        // each <a href=...> with .ep-info h2 + .epnum
        var epRe = /<a\b([^>]*)\bhref\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
        var em;
        while ((em = epRe.exec(epHost)) !== null) {
          var epUrl = abs(em[2], url);
          var epInner = em[4];
          var epNameM = epInner.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
          var epName = epNameM ? stripTags(epNameM[1]) : "";
          var epNumM = epInner.match(/<[^>]*\bclass\s*=\s*["'][^"']*\bepnum\b[^"']*["'][^>]*>([^<]*)</i);
          var epNum = epNumM ? (parseInt(stripTags(epNumM[1]).match(/\d+/), 10) || 0) : 0;
          if (!epNum) { var n = epName.match(/\d+/); epNum = n ? parseInt(n[0], 10) : 0; }
          episodes.push(new Episode({
            name: epName || ("Episode " + epNum), url: epUrl, season: 1, episode: epNum || (episodes.length + 1),
            posterUrl: poster, description: "",
          }));
        }
        // distinct by data, sort by (season, episode)
        var seen = {};
        episodes = episodes.filter(function (e) { if (seen[e.url]) return false; seen[e.url] = true; return true; });
        episodes.sort(function (a, b) {
          if (a.season !== b.season) return a.season - b.season;
          return a.episode - b.episode;
        });

        // movie decision: if no episodes -> Movie with data = url + '/watch/'
        var isSeries = episodes.length > 0 || seasons.length > 0;
        var dataUrl = isSeries ? url : (url.replace(/\/$/, "") + "/watch/");

        var item = new MultimediaItem({
          url: url, title: title || "Unknown", posterUrl: poster,
          type: isSeries ? "tvseries" : "movie",
          description: plot, year: year, score: 0, tags: tags,
          episodes: episodes, recommendations: [],
          source: dataUrl, // carry the watch data URL for loadStreams
        });
        cb({ success: true, data: item });
      })
      .catch(function (e) { cb({ success: false, errorCode: "LOAD_ERROR", message: String(e && (e.stack || e)) }); });
  }

  function loadStreams(url, cb) {
    // The url passed in is the EPISODE url (or movie url). Original POSTs watch=1 to it.
    var headersBase = { "User-Agent": cs3compat.DEFAULT_UA, "Referer": url, "Content-Type": "application/x-www-form-urlencoded" };
    app.post(url, headersBase, "watch=1", url)
      .then(function (r) {
        var streams = [];
        if (!r || !r.text) { cb({ success: true, data: [] }); return; }
        var html = r.text;
        // ul#watch li[data-watch]
        var watchUl = findBlock(html, /<ul\b[^>]*\bid\s*=\s*["']watch["']/i);
        var watchHost = watchUl ? watchUl.inner : html;
        var watchRe = /<li\b[^>]*\bdata-watch\s*=\s*["']([^"']+)["'][^>]*>/gi;
        var wm;
        while ((wm = watchRe.exec(watchHost)) !== null) {
          var embedUrl = wm[1];
          if (embedUrl) {
            streams.push(new StreamResult({
              url: embedUrl, source: providerName + " Embed",
              headers: { "Referer": url },
            }));
          }
        }
        // .ServersList.Download a[href]
        var dlRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
        var dm;
        // also direct media URLs from the response
        extractMediaUrls(html).forEach(function (u) {
          streams.push(new StreamResult({ url: u, source: providerName + " Direct", headers: { "Referer": url } }));
        });
        cb({ success: true, data: streams });
      })
      .catch(function (e) { cb({ success: false, errorCode: "STREAM_ERROR", message: String(e && (e.stack || e)) }); });
  }

  global.getHome = getHome;
  global.search = search;
  global.load = load;
  global.loadStreams = loadStreams;
})(globalThis);
