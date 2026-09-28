# Porting Guide — 3arabi CloudStream providers → SkyStream

This guide documents the methodology used to port the 4 shipped providers
(3isk, Aflaam, Akwam, CimaClub) and the step-by-step process to port the
remaining 35. The `cs3compat.js` shim + the 4 example plugins are the
template; the per-provider work is mostly mechanical.

## TL;DR — porting one provider

1. **Decompile** the `.cs3` with jadx:
   ```bash
   curl -sL "https://raw.githubusercontent.com/Abodabodd/re-3arabi/builds/<Name>.cs3" -o /tmp/p.cs3
   unzip -p /tmp/p.cs3 manifest.json   # find pluginClassName
   /home/z/my-project/tools/jadx/bin/jadx --show-bad-code --no-imports -d /tmp/p_dec /tmp/p.cs3
   ```
2. **Read** the main provider `.java` (the file matching `pluginClassName` minus
   `Plugin`). Note `mainUrl`, `getMainPage`/`search`/`load`/`loadLinks` flows,
   and ALL jsoup selectors + regex patterns.
3. **Extract the DEX string pool** for selectors jadx couldn't decompile
   (complex `loadLinks` bodies):
   ```bash
   strings -n 4 classes.dex | grep -iE 'watch|form|input|button|serie-btn|qualities|link-show|video|source|/movie|/series|/episode'
   ```
4. **Create** `plugins/<name>/{plugin.json,plugin.js}`. Use `plugins/aflaam/` (simplest)
   or `plugins/3isk/` (most complex — packer unpacker) as your starting template.
5. **Map** the CloudStream calls:
   - `app.get(url, headers, referer)` → `app.get(url, headers, referer)` (cs3compat)
   - `Jsoup.parse(html).select(sel)` → `findAllBlocks(html, /<regex for sel>/)` (regex-based)
   - `Base64.decode(s)` → `decodeBase64Compat(s)`
   - `eval(function(p,a,c,k,e,d)…)` packer → `analyzeAndSaveEvalScripts(html)`
   - `callback(ExtractorLink(...))` → `streams.push(new StreamResult({url, source, headers:{Referer}}))`
6. **Build & test**:
   ```bash
   node build/build.js
   node --check /tmp/extracted/plugin.js   # syntax
   ```
7. **Add** the provider to the catalog (`build/all-providers-catalog.json`) and
   re-run `node build/build.js` to regenerate `dist/plugins.json`.

## The 6 entry points a SkyStream plugin must expose

```js
globalThis.getHome = function(cb) { /* cb({success, data: {sectionName: [MultimediaItem]}}) */ };
globalThis.search  = function(query, page, cb) { /* cb({success, data: [MultimediaItem]}) */ };
globalThis.load    = function(url, cb) { /* cb({success, data: MultimediaItem}) */ };
globalThis.loadStreams = function(url, cb) { /* cb({success, data: [StreamResult]}) */ };
// optional:
globalThis.getProviders = function(cb) { /* for multi-provider shells */ };
globalThis.getSettings  = function(cb) { /* dynamic settings */ };
```

**Callback convention:** single-arg `(response)`, NOT Node-style `(err, result)`.
You may also return a Promise (resolved value becomes the response).

**Response envelope:** `{success: true, data: ...}` on success,
`{success: false, errorCode: "...", message: "..."}` on failure. `errorCode` is
an open string (only `UNKNOWN_ERROR` is special-cased by SkyStream).

## The cs3compat helpers (already bundled into every .sky)

| Helper | Signature | Returns |
|--------|----------|---------|
| `app.get(url, headers?, referer?)` | Promise | `{text, code, finalUrl, headers}` |
| `app.post(url, headers?, body?, referer?)` | Promise | same |
| `decodeBase64Compat(s)` | sync | `string \| null` (tries standard, url-safe, stripped) |
| `unpackPacker(evalText)` | sync | unpacked JS string, or `null` |
| `extractMediaUrls(html)` | sync | `[url, …]` matching `.m3u8/.mp4/.webm/.mov` |
| `analyzeAndSaveEvalScripts(html)` | sync | `[url, …]` from `<script>` packers |
| `getAllIframeSrcs(html)` | sync | `[src, …]` |
| `absUrl(u, base)` | sync | absolute URL |
| `host(u)` | sync | hostname |
| `newMovieLoadResponse(opts)` | sync | `MultimediaItem` (movie, with 1 "Full Movie" episode) |
| `newTvSeriesLoadResponse(opts)` | sync | `MultimediaItem` (tvseries, with episodes) |

## Mapping CloudStream → SkyStream (cheat sheet)

| CloudStream (Kotlin) | SkyStream (JS) |
|---------------------|----------------|
| `mainUrl = "https://..."` | `manifest.baseUrl` (read via `manifest.baseUrl`) |
| `name = "..."` | `manifest.name` |
| `supportedTypes = setOf(TvType.Movie, TvType.TvSeries)` | `categories: ["Movie","TvSeries"]` in `plugin.json` |
| `lang = "ar"` | `languages: ["ar"]` in `plugin.json` |
| `hasMainPage = true` | implement `getHome` |
| `suspend fun search(query): List<SearchResponse>` | `search(query, page, cb)` → `cb({success, data:[MultimediaItem]})` |
| `suspend fun load(url): LoadResponse` | `load(url, cb)` → `cb({success, data: MultimediaItem})` |
| `suspend fun loadLinks(data, isCasting, subCb, cb): Boolean` | `loadStreams(url, cb)` → `cb({success, data:[StreamResult]})` |
| `app.get(url).document.select(sel)` | regex `findAllBlocks(html, /<regex>/)` (see aflaam.js) |
| `Jsoup.parse(html)` | regex on `html` directly (or `parseHtml` async if available) |
| `Base64.decode(s)` (multi-flag) | `decodeBase64Compat(s)` |
| `Regex.findAll(re, s)` | `s.match(re)` / `re.exec(s)` loop |
| `newExtractorLink(source, name, url).setQuality(q)` | `new StreamResult({url, source, headers:{Referer}})` |
| `subtitleCallback(SubtitleFile(label, url))` | `new StreamResult({url, source, subtitles:[{url,label,lang}]})` |
| `loadExtractor(url, referer, subCb, cb)` | **NO EQUIVALENT** — see "ExtractorApi gap" below |
| `app.get(url, headers = headers, referer = mainUrl)` | `app.get(url, headers, mainUrl)` |
| `MainActivityKt.getApp()` | (implicit; just call `app.get`) |

## Category mapping (CloudStream TvType → SkyStream categories)

| CloudStream `TvType` | SkyStream `categories` |
|---------------------|----------------------|
| `Movie` | `Movie` |
| `TvSeries` | `TvSeries` |
| `Anime` | `Anime` |
| `AsianDrama`, `Documentary`, `Cartoon`, `Torrent`, `Audio`, `AudioBook`, `Custom` | `Other` (SkyStream doesn't model these) |
| `Live`, `LiveStream`, `IPTV` | `LiveTv` |

## The 3isk loadLinks pattern (reusable for the 17 HARD providers)

8 of the 17 HARD providers (3isk, Bristege, Topcinema, Egydead, Lodynet,
Shahid4u, Witanime, Animerco) share the **same** loadLinks structure:

1. GET episode URL → find watch `<form>` (button `.single-watch-btn` or similar)
2. POST the form's hidden inputs → get a second page
3. Extract `mMyurl`/`mNews` hidden inputs (+ sometimes a `myInput.value = "..."`
   inline-JS obfuscated value) → POST again → get the embed page
4. Find iframes; for each embed server, GET it, then:
   - `extractMediaUrls(html)` for direct URLs
   - `analyzeAndSaveEvalScripts(html)` for Dean-Edwards-packed URLs
   - follow the first nested iframe and repeat

The 3isk plugin (`plugins/3isk/plugin.js`) is a complete reference implementation
of this pattern — copy it and adjust only the site-specific selectors and the
embed-URL regex. The cs3compat helpers (`unpackPacker`,
`analyzeAndSaveEvalScripts`, `getAllIframeSrcs`, `processSingleEmbedServer`
equivalent inline in 3isk.js) are already battle-tested.

## ExtractorApi gap (the one true blocker)

CloudStream's `loadExtractor(url, referer, subCb, cb)` delegates to a registry of
~30 dedicated host extractors (vidplay, streamtape, doodstream, mixdrop,
mp4upload, ok.ru, etc.). SkyStream has **no** equivalent — plugins can only do
`http_get` + regex.

**Three mitigation strategies, in order of effort:**

1. **Regex-recover the direct URL** (works for ~40% of embed hosts that embed a
   direct `.mp4`/`.m3u8` in their HTML or in a JSON endpoint). This is what
   `cs3compat.analyzeAndSaveEvalScripts` + `extractMediaUrls` already do.
2. **Port the host extractor as a JS helper** in `cs3compat.js`. Each is ~50-100
   lines: hit the host's API endpoint, parse the JSON/regex response, return the
   direct URL. Add helpers like `extractVidplay(url)`, `extractStreamtape(url)`,
   etc., then call them from `loadStreams`.
3. **Propose a SkyStream platform feature**: add a `loadExtractor(url, referer)`
   JS global backed by the app's existing extractor registry. This is the
   cleanest long-term fix but requires modifying SkyStream itself.

For CimaClub (shipped), strategy #1 is applied: embed URLs are emitted as
`StreamResult` directly. They play when direct; otherwise listed.

## Testing a ported provider

### 1. Syntax check
```bash
node build/build.js
tmp=$(mktemp -d) && unzip -q dist/<pkg>.sky -d "$tmp"
node --check "$tmp/plugin.js" && echo OK
```

### 2. Load test (does it expose all 4 entry points?)
Adapt `/tmp/test-all-load.js` (in this repo's worklog) — it mocks `http_get`,
`http_post`, `MultimediaItem`, `Episode`, `StreamResult`, then `eval`s the
plugin and asserts `getHome`/`search`/`load`/`loadStreams` are functions.

### 3. End-to-end test
Adapt `/tmp/test-3isk-e2e.js` — mock `http_get`/`http_post` to return canned
HTML for each step of your provider's flow, then call `loadStreams(url, cb)` and
assert the returned `StreamResult[]` contains the expected media URL.

### 4. Real-device test
Publish to GitHub, add the repo URL to SkyStream, install the provider, search
for a known title, open it, play an episode. Check SkyStream's plugin logs for
runtime errors.

## Recommended porting order

1. **EASY (4):** Alooytv, Cee, cinemana, TuniflexBlog — direct sources, no
   packer, no extractor. ~1 hour each following the Aflaam template.
2. **HARD with 3isk packer pattern (8):** Bristege, Topcinema, Egydead,
   Lodynet, Shahid4u, Witanime, Animerco, (3isk already done). Copy 3isk.js,
   swap selectors. ~2-3 hours each.
3. **MEDIUM REST-API (4):** cinemana (Shahid-like JSON), Cee, Viu (OAuth),
   Yacintv (Firebase). Hit JSON endpoints directly — cleanest ports.
4. **MEDIUM embed-host (9):** TVgarden, dima-toon, Shahidwbas, Syria-live,
   TukTukcima, Tuniflix, Cimatn, Aia2tv 2, AnimeRift. Apply ExtractorApi gap
   strategy #1 or #2.
5. **HARD embed-host (9):** Anim3rb, Elif, Krmzy, eseek, Anime-Phoenix,
   Replaymatch, Wecima, Cimalight, Anime4up, Animewitcher, MyCimaProvider.
   Same as #4 but with more hosts.
6. **YouTube (1):** needs a dedicated yt-dlp-style extractor. Large but
   self-contained.
7. **BLOCKED (1):** Faselhd. Wait for SkyStream to add a plugin-facing WebView,
   or implement a server-side fetch-hook proxy (out of scope for a plugin).

## Per-provider porting notes

See `build/all-providers-catalog.json` for the `portingNote` field on each of
the 39 providers, and `docs/PORTING_STATUS.md` for the live matrix. The
detailed per-provider selector specs (from the jadx analysis) are in
`/home/z/my-project/research/analysis/provider_selectors.json` (Aflaam, Akwam,
CimaClub) and `/home/z/my-project/research/analysis/per_plugin.txt` (all 39).
