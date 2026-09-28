/*
 * 3isk (قصة عشق) — SkyStream native JS port
 * Original: com.eshk.eishk (CloudStream .cs3, re-3arabi builds)
 * Ported faithfully from the decompiled Kotlin source.
 *
 * Site: https://3esk.onl  (Arabic movies & TV series)
 *
 * Flow:
 *   getHome  -> GET mainUrl, parse `section.home-items-sec` + items
 *   search   -> GET mainUrl + "/search/<q>/", parse `ul.search-page li a.type_item`
 *   load     -> GET url; if episode page, recurse to series; parse seasons/episodes
 *               (episode URLs are base64-encoded in `data-clse` attribute)
 *   loadStreams -> multi-POST watch flow (form -> mMyurl/mNews -> r2),
 *                  then iterate embed servers `3esk.onl/embed/<id>/<trailing>`,
 *                  unpack Dean-Edwards packer, extract direct .mp4/.m3u8 URLs.
 *
 * Helper layer (bundled before this file): cs3compat.js
 *   Provides: app, decodeBase64Compat, unpackPacker, analyzeAndSaveEvalScripts,
 *             getAllIframeSrcs, extractMediaUrls, absUrl, host.
 */
(function (global) {
  "use strict";

  var M = (typeof manifest !== "undefined" && manifest) || {};
  var mainUrl = (M.baseUrl || M.customBaseUrl || "https://3esk.onl").replace(/\/+$/, "");
  var providerName = M.name || "3isk";
  var MAX_SERVERS = 5;

  // ---------- HTML helpers (regex-based, jsoup-equivalent) ----------
  // Extract text content of the first element matching `selector`-ish regex.
  // We support a small subset of jsoup selectors sufficient for this port:
  //   "tag"
  //   "tag.class"
  //   "tag#id"
  //   "tag[attr]"
  //   "parent child"
  //   "parent > child"
  function _escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // Match an element <tag ...> with optional class/id/attr filters; returns the
  // inner HTML of the FIRST match.
  function selectFirstHtml(html, selector) {
    var parts = selector.trim().split(/\s+/);
    var cur = html;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var direct = p.startsWith(">");
      if (direct) p = p.slice(1);
      var m = p.match(/^([a-zA-Z0-9]+)?(?:\.([a-zA-Z0-9_-]+))?(?:#([a-zA-Z0-9_-]+))?(?:\[([^\]=]+)(?:([~^$*]?=)"?([^"\]]*)"?)?\])?$/);
      if (!m) continue;
      var tag = m[1] || "[a-zA-Z0-9]+";
      var cls = m[2], id = m[3], attrName = m[4], attrVal = m[6];
      var re = "<(" + tag + ")\\b[^>]*>";
      var tagRe = new RegExp(re, "gi");
      var found = null, mm;
      while ((mm = tagRe.exec(cur)) !== null) {
        var openIdx = mm.index;
        var openTag = mm[0];
        var clsOk = true, idOk = true, attrOk = true;
        if (cls) {
          var clsRe = new RegExp("\\bclass\\s*=\\s*[\"'][^\"']*\\b" + _escRe(cls) + "\\b");
          clsOk = clsRe.test(openTag);
        }
        if (id) {
          var idRe = new RegExp("\\bid\\s*=\\s*[\"']" + _escRe(id) + "[\"']");
          idOk = idRe.test(openTag);
        }
        if (attrName) {
          var attrRe = new RegExp("\\b" + _escRe(attrName) + "\\s*=" +
            (attrVal != null ? "\\s*[\"']" + _escRe(attrVal) + "[\"']" : ""));
          attrOk = attrRe.test(openTag);
        }
        if (clsOk && idOk && attrOk) {
          // find matching close tag
          var closeRe = new RegExp("</" + mm[1] + "\\s*>", "gi");
          closeRe.lastIndex = openIdx + openTag.length;
          // naive: nearest close of same tag (depth-aware)
          var depth = 1, idx = openIdx + openTag.length, cm;
          var depthRe = new RegExp("<(/?)" + mm[1] + "\\b[^>]*>", "gi");
          depthRe.lastIndex = idx;
          while ((cm = depthRe.exec(cur)) !== null) {
            if (cm[1] === "/") depth--;
            else depth++;
            if (depth === 0) {
              found = cur.substring(openIdx, cm.index + cm[0].length);
              break;
            }
          }
          if (found) break;
        }
      }
      cur = found || "";
    }
    return cur;
  }

  function selectAllHtml(html, selector) {
    // Returns array of {html, attrs} for each top-level match of the LAST
    // selector segment, scoped by preceding segments.
    var parts = selector.trim().split(/\s+/);
    var scope = html;
    for (var i = 0; i < parts.length - 1; i++) {
      scope = selectFirstHtml(scope, parts[i]) || "";
    }
    var last = parts[parts.length - 1] || "";
    var direct = last.startsWith(">");
    if (direct) last = last.slice(1);
    var m = last.match(/^([a-zA-Z0-9]+)?(?:\.([a-zA-Z0-9_-]+))?(?:#([a-zA-Z0-9_-]+))?(?:\[([^\]=]+)(?:([~^$*]?=)"?([^"\]]*)"?)?\])?$/);
    if (!m) return [];
    var tag = m[1] || "[a-zA-Z0-9]+";
    var cls = m[2], id = m[3], attrName = m[4], attrVal = m[6];
    var results = [];
    var tagRe = new RegExp("<(" + tag + ")\\b[^>]*>", "gi");
    var mm;
    while ((mm = tagRe.exec(scope)) !== null) {
      var openTag = mm[0];
      var clsOk = !cls || new RegExp("\\bclass\\s*=\\s*[\"'][^\"']*\\b" + _escRe(cls) + "\\b").test(openTag);
      var idOk = !id || new RegExp("\\bid\\s*=\\s*[\"']" + _escRe(id) + "[\"']").test(openTag);
      var attrOk = !attrName || new RegExp("\\b" + _escRe(attrName) + "\\s*=" + (attrVal != null ? "\\s*[\"']" + _escRe(attrVal) + "[\"']" : "")).test(openTag);
      if (!(clsOk && idOk && attrOk)) continue;
      var depth = 1, cm;
      var depthRe = new RegExp("<(/?)" + mm[1] + "\\b[^>]*>", "gi");
      depthRe.lastIndex = tagRe.lastIndex;
      var endIdx = scope.length;
      while ((cm = depthRe.exec(scope)) !== null) {
        if (cm[1] === "/") depth--;
        else depth++;
        if (depth === 0) { endIdx = cm.index + cm[0].length; break; }
      }
      results.push({ html: scope.substring(mm.index, endIdx), openTag: openTag });
      tagRe.lastIndex = endIdx;
    }
    return results;
  }

  function attr(elHtml, name) {
    if (!elHtml) return "";
    var m = elHtml.match(new RegExp("\\b" + _escRe(name) + "\\s*=\\s*[\"']([^\"']*)[\"']"));
    return m ? m[1] : "";
  }

  function text(elHtml) {
    if (!elHtml) return "";
    // strip tags
    var inner = elHtml.replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "");
    // remove nested tags
    inner = inner.replace(/<[^>]+>/g, " ");
    // decode common entities
    inner = inner.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return inner.replace(/\s+/g, " ").trim();
  }

  // ---------- toSearchResponse (decode base64 data-clse, detect type) ----------
  function toSearchResponse(aHtml) {
    if (!aHtml) return null;
    var encodedUrl = attr(aHtml, "data-clse");
    var href = "";
    if (encodedUrl) {
      href = decodeBase64Compat(encodedUrl) || attr(aHtml, "href");
    } else {
      href = attr(aHtml, "href");
    }
    if (!href) return null;
    var title = attr(aHtml, "title");
    // poster
    var imgHtml = selectFirstHtml(aHtml, "img");
    var poster = attr(imgHtml, "data-image") || attr(imgHtml, "src");
    poster = absUrl(poster, mainUrl);

    var type;
    if (href.indexOf("/tvshows/") !== -1) type = "tvseries";
    else if (href.indexOf("/movies/") !== -1) type = "movie";
    else if (href.indexOf("/episodes/") !== -1) {
      // strip " الحلقة" suffix
      title = title.split(" الحلقة")[0].trim() || title;
      type = "tvseries";
    } else {
      return null;
    }
    href = absUrl(href, mainUrl);
    return new MultimediaItem({
      url: href, title: title, posterUrl: poster, type: type,
    });
  }

  // ---------- getHome ----------
  function getHome(cb) {
    Promise.resolve()
      .then(function () { return app.get(mainUrl); })
      .then(function (r) {
        var sections = {};
        if (r && r.text) {
          var secs = selectAllHtml(r.text, "section.home-items-sec");
          for (var i = 0; i < secs.length; i++) {
            var sec = secs[i].html;
            var titleEl = selectFirstHtml(sec, ".sec-title");
            var secTitle = text(titleEl) || ("Section " + (i + 1));
            var items = selectAllHtml(sec, "li.type_item_box a.type_item");
            if (!items.length) items = selectAllHtml(sec, "li.type_item_wide_box a.type_item_wide");
            var arr = [];
            for (var j = 0; j < items.length; j++) {
              var it = toSearchResponse(items[j].html);
              if (it) arr.push(it);
            }
            if (arr.length) sections[secTitle] = arr;
          }
        }
        cb({ success: true, data: sections });
      })
      .catch(function (e) { cb({ success: false, errorCode: "SITE_OFFLINE", message: String(e) }); });
  }

  // ---------- search ----------
  function search(query, page, cb) {
    Promise.resolve()
      .then(function () {
        var url = mainUrl + "/search/" + encodeURIComponent(query) + "/";
        return app.get(url);
      })
      .then(function (r) {
        var results = [];
        if (r && r.text) {
          var lis = selectAllHtml(r.text, "ul.search-page li.type_item_box a.type_item");
          for (var i = 0; i < lis.length; i++) {
            var it = toSearchResponse(lis[i].html);
            if (it) results.push(it);
          }
        }
        cb({ success: true, data: results });
      })
      .catch(function (e) { cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e) }); });
  }

  // ---------- load ----------
  function load(url, cb) {
    Promise.resolve()
      .then(function () { return app.get(url); })
      .then(function (r) {
        if (!r || !r.text) { cb({ success: false, errorCode: "LOAD_ERROR", message: "empty response" }); return; }
        var html = r.text;

        // Episode page? follow to series URL via a.single-serie-btn
        var seriesBtnHtml = selectFirstHtml(html, "a.single-serie-btn");
        if (seriesBtnHtml) {
          var seriesUrl = attr(seriesBtnHtml, "href");
          if (seriesUrl) {
            seriesUrl = absUrl(seriesUrl, url);
            // recurse
            load(seriesUrl, cb);
            return;
          }
        }

        var titleEl = selectFirstHtml(html, "div.single_info h1.title");
        var rawTitle = text(titleEl);
        var title = (rawTitle || "Unknown").replace(/مترجم/g, "").replace(/مدبلج/g, "").trim();

        var posterEl = selectFirstHtml(html, "div.poster-wrapper img");
        var poster = attr(posterEl, "src");
        poster = absUrl(poster, url);

        var descEl = selectFirstHtml(html, "div.description span[data-nosnippet]");
        var description = text(descEl);

        var isSeries = url.indexOf("/tvshows/") !== -1;
        var type = isSeries ? "tvseries" : "movie";

        var episodes = [];
        if (isSeries) {
          var seasonDivs = selectAllHtml(html, "div.season-eps");
          for (var s = 0; s < seasonDivs.length; s++) {
            var seasonDiv = seasonDivs[s].html;
            var seasonNum = s + 1;
            // try to read season number from a header if present
            var epLinks = selectAllHtml(seasonDiv, "a.ep-num");
            for (var e = 0; e < epLinks.length; e++) {
              var epA = epLinks[e].html;
              var epEnc = attr(epA, "data-clse");
              var epUrl = epEnc ? (decodeBase64Compat(epEnc) || attr(epA, "href")) : attr(epA, "href");
              if (!epUrl) continue;
              epUrl = absUrl(epUrl, url);
              var epName = attr(epA, "title") || ("Episode " + (e + 1));
              var epNum = e + 1;
              episodes.push(new Episode({
                name: epName, url: epUrl, season: seasonNum, episode: epNum,
                posterUrl: poster, description: "",
              }));
            }
          }
          // sort by season then episode
          episodes.sort(function (a, b) {
            if (a.season !== b.season) return a.season - b.season;
            return a.episode - b.episode;
          });
        }

        var item = new MultimediaItem({
          url: url, title: title, posterUrl: poster, type: type,
          description: description || "", year: 0, score: 0,
          episodes: episodes,
          recommendations: [],
        });
        cb({ success: true, data: item });
      })
      .catch(function (e) { cb({ success: false, errorCode: "LOAD_ERROR", message: String(e && (e.stack || e)) }); });
  }

  // ---------- processSingleEmbedServer (faithful port) ----------
  // GET embed URL -> extract direct media URLs (regex + packer unpack) ->
  // follow first nested iframe -> repeat.
  function processSingleEmbedServer(embedUrl, refererFromPrevPage, headersBase, serverLabel) {
    return Promise.resolve()
      .then(function () {
        var hdrs = Object.assign({}, headersBase || {});
        hdrs["Referer"] = refererFromPrevPage;
        return app.get(embedUrl, hdrs, refererFromPrevPage);
      })
      .then(function (r) {
        var result = [];
        if (!r || !r.text) return result;
        var text1 = r.text;
        // 1. direct media URLs from raw HTML
        extractMediaUrls(text1).forEach(function (u) { result.push(u); });
        // 2. media URLs from unpacked packers
        analyzeAndSaveEvalScripts(text1).forEach(function (u) { result.push(u); });
        // 3. follow first nested iframe
        var iframeSrcs = getAllIframeSrcs(text1);
        if (iframeSrcs.length === 0) return result;
        var iframe2 = absUrl(iframeSrcs[0], embedUrl);
        var hdrs2 = Object.assign({}, hdrs);
        hdrs2["Referer"] = embedUrl;
        return app.get(iframe2, hdrs2, embedUrl).then(function (r2) {
          if (!r2 || !r2.text) return result;
          var t = r2.text;
          extractMediaUrls(t).forEach(function (u) { result.push(u); });
          analyzeAndSaveEvalScripts(t).forEach(function (u) { result.push(u); });
          return result;
        });
      });
  }

  // ---------- loadStreams (the watch-flow port) ----------
  function loadStreams(url, cb) {
    var headersBase = { "User-Agent": cs3compat.DEFAULT_UA };
    var collected = {}; // dedupe by url

    Promise.resolve()
      .then(function () {
        // STEP 1: GET episode url -> soup0
        return app.get(url, headersBase, url);
      })
      .then(function (r0) {
        if (!r0 || !r0.text) throw new Error("No response from episode page");
        var soup0 = r0.text;

        // STEP 2: find watch form -> firstPostUrl + firstFormData
        var watchForm = selectFirstHtml(soup0, "form");
        var watchBtn = selectFirstHtml(soup0, "button.single-watch-btn");
        if (!watchForm) {
          // Fallback: maybe direct media URLs on the page already
          var direct = extractMediaUrls(soup0).concat(analyzeAndSaveEvalScripts(soup0));
          return { r2text: soup0, iframes: getAllIframeSrcs(soup0), direct: direct };
        }
        var firstPostUrl = absUrl(attr(watchForm, "action") || url, url);
        var hiddenInputs = selectAllHtml(watchForm, "input[type=hidden]");
        var firstFormData = {};
        hiddenInputs.forEach(function (h) {
          var n = attr(h.html, "name");
          var v = attr(h.html, "value");
          if (n) firstFormData[n] = v;
        });

        // STEP 3: POST firstFormData to firstPostUrl -> r1
        return app.post(firstPostUrl, headersBase, _encodeForm(firstFormData), url)
          .then(function (r1) {
            if (!r1 || !r1.text) throw new Error("No response from first POST");
            var r1text = r1.text;

            // STEP 4: find second form in r1 -> mMyurl, mNews, nextPost, newsVal
            // hidden inputs
            var form2 = selectFirstHtml(r1text, "form") || r1text;
            var hidden2 = selectAllHtml(form2, "input[type=hidden]");
            var post2Data = {};
            hidden2.forEach(function (h) {
              var n = attr(h.html, "name");
              var v = attr(h.html, "value");
              if (n) post2Data[n] = v;
            });
            // also extract mMyurl / mNews from inline JS: myInput.value = "..."
            var myInputRe = /myInput\.value\s*=\s*["']([^"']+)["']/g;
            var myInputMatches = [];
            var mm;
            while ((mm = myInputRe.exec(r1text)) !== null) myInputMatches.push(mm[1]);
            if (!post2Data.mMyurl && myInputMatches.length) post2Data.mMyurl = myInputMatches[0];
            if (!post2Data.mNews && myInputMatches.length > 1) post2Data.mNews = myInputMatches[1];

            var nextPost = absUrl(attr(form2, "action") || firstPostUrl, firstPostUrl);
            var newsVal = "";
            var btn2 = selectFirstHtml(form2, "button");
            if (btn2) newsVal = attr(btn2, "value") || text(btn2);

            // STEP 5: POST post2Data to nextPost -> r2
            return app.post(nextPost, headersBase, _encodeForm(post2Data), firstPostUrl)
              .then(function (r2) {
                var r2text = r2 && r2.text ? r2.text : "";
                return { r2text: r2text, iframes: getAllIframeSrcs(r2text), direct: [] };
              });
          });
      })
      .then(function (step) {
        // STEP 6: collect iframes + direct media from r2
        var r2text = step.r2text || "";
        var allMedia = step.direct.slice();
        extractMediaUrls(r2text).forEach(function (u) { allMedia.push(u); });
        analyzeAndSaveEvalScripts(r2text).forEach(function (u) { allMedia.push(u); });

        var iframes = (step.iframes || []).map(function (s) { return absUrl(s, url); });
        // Embed pattern: https://3esk.onl/embed/<id>/<trailing>
        var embedRe = /^https?:\/\/(?:[^/]*\.)?3esk\.onl\/embed\/(\d+)\/(.*)$/i;
        var servers = [];
        for (var i = 0; i < iframes.length; i++) {
          var em = iframes[i].match(embedRe);
          if (em) {
            var trailing = em[2];
            // expand servers 1..MAX_SERVERS by replacing the leading number segment
            for (var n = 1; n <= MAX_SERVERS; n++) {
              var serverUrl = mainUrl + "/embed/" + n + "/" + trailing;
              servers.push({ url: serverUrl, label: "Server " + n });
            }
          } else {
            servers.push({ url: iframes[i], label: "Embed" });
          }
        }

        // STEP 7: process each embed server (cap to avoid runaway)
        var tasks = servers.slice(0, 15).map(function (s) {
          return processSingleEmbedServer(s.url, url, headersBase, s.label)
            .then(function (urls) {
              return { label: s.label, urls: urls };
            });
        });
        return Promise.all(tasks).then(function (results) {
          // STEP 8: emit StreamResult for each unique direct media URL
          var streams = [];
          for (var i = 0; i < allMedia.length; i++) {
            var u = allMedia[i];
            if (!collected[u]) {
              collected[u] = true;
              streams.push(new StreamResult({
                url: u, source: providerName + " Auto", headers: { "Referer": mainUrl },
              }));
            }
          }
          for (var r = 0; r < results.length; r++) {
            var urls = results[r].urls;
            for (var k = 0; k < urls.length; k++) {
              var mu = urls[k];
              if (!collected[mu]) {
                collected[mu] = true;
                streams.push(new StreamResult({
                  url: mu, source: providerName + " " + results[r].label,
                  headers: { "Referer": mainUrl + "/" },
                }));
              }
            }
          }
          return streams;
        });
      })
      .then(function (streams) {
        cb({ success: true, data: streams });
      })
      .catch(function (e) {
        cb({ success: false, errorCode: "STREAM_ERROR", message: String(e && (e.stack || e)) });
      });
  }

  function _encodeForm(obj) {
    var parts = [];
    Object.keys(obj || {}).forEach(function (k) {
      if (obj[k] != null) parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]));
    });
    return parts.join("&");
  }

  // ---------- expose entry points ----------
  global.getHome = getHome;
  global.search = search;
  global.load = load;
  global.loadStreams = loadStreams;
})(globalThis);
