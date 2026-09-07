const DEBUG = false;
const dlog = (...args) => DEBUG && console.log("[XFetch/content]", ...args);
dlog("content script loaded");

const PROCESSED_ATTR = "data-twitterdl-processed";

/* Download glyph: arrow into tray (matches package icon). */
const SHARE_ARROW_D =
  "M12 16l5.7-5.7-1.41-1.42L13 12.17V4h-2v8.17L7.71 8.88 6.29 10.3 12 16z";
const SHARE_TRAY_D =
  "M21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z";

/** Inner markup: download arrow + tray. */
const BTN_SVG_INNER = `<g>
  <path d="${SHARE_ARROW_D}"></path>
  <path d="${SHARE_TRAY_D}"></path>
</g>`;

const BTN_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">${BTN_SVG_INNER}</svg>`;

/** Prefer cloning Share's <svg> so X size classes travel with the glyph. */
function buildDownloadSvg(shareBtn) {
  const shareSvg = shareBtn?.querySelector?.("svg");
  if (shareSvg) {
    const svg = shareSvg.cloneNode(false);
    for (const attr of shareSvg.attributes) {
      svg.setAttribute(attr.name, attr.value);
    }
    svg.setAttribute("aria-hidden", "true");
    // Drop any fixed pixel size Share may have set; CSS + X classes own sizing.
    svg.style.removeProperty("width");
    svg.style.removeProperty("height");
    svg.innerHTML = BTN_SVG_INNER;
    return svg;
  }
  const tmp = document.createElement("div");
  tmp.innerHTML = BTN_SVG;
  return tmp.firstElementChild;
}

const activeGifDownloads = new Map();

/** Last video the user right-clicked (for blob:/missing srcUrl context-menu saves). */
let lastContextVideo = null;
let lastContextTweetId = null;
let lastContextArticle = null;

/** Parent tweet id from its <time> permalink (first time in the article). */
function ownTweetIdFromTime(article) {
  if (!article) return null;
  for (const time of article.querySelectorAll("time")) {
    const link = time.closest?.('a[href*="/status/"]');
    if (!link) continue;
    if (link.closest('[data-testid="quoteTweet"], [data-testid="tweetQuote"]')) continue;
    const wrap = link.closest('[role="link"]');
    if (wrap && !wrap.querySelector('[role="group"]')) {
      const hasTimeOutside = [...article.querySelectorAll("time")].some((t) => !wrap.contains(t));
      if (hasTimeOutside) continue;
    }
    const id = link.href.match(/\/status\/(\d+)/)?.[1];
    if (id) return id;
  }
  return null;
}

/** Own status link -- prefer the <time> permalink so quoted tweets don't win. */
function ownStatusLink(article) {
  const timeLink = article.querySelector("time")?.closest?.('a[href*="/status/"]');
  if (timeLink && !isInsideQuotedTweet(timeLink, article)) return timeLink;
  for (const link of article.querySelectorAll('a[href*="/status/"]')) {
    if (!isInsideQuotedTweet(link, article)) return link;
  }
  return null;
}

function getTweetId(article) {
  // Always prefer the first <time> permalink -- on X that is the parent post,
  // even when a quote card also has times/links.
  const fromTime = ownTweetIdFromTime(article);
  if (fromTime) return fromTime;
  const link = ownStatusLink(article);
  if (!link) return null;
  const match = link.href.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function getTweetUsername(article) {
  const link = ownStatusLink(article);
  if (!link) return "";
  const match = link.href.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\//);
  return match ? match[1] : "";
}

/**
 * Root of the quoted-tweet card (text and/or media).
 * Feed layouts often put quote video beside the role=link text card, not inside it.
 */
function domLca(a, b, stop) {
  if (!a || !b || !stop) return null;
  const seen = new Set();
  let n = a;
  while (n && n !== stop) {
    seen.add(n);
    n = n.parentElement;
  }
  n = b;
  while (n && n !== stop) {
    if (seen.has(n)) return n;
    n = n.parentElement;
  }
  return null;
}

function domDepth(from, node) {
  let d = 0;
  let n = node;
  while (n && n !== from) {
    d += 1;
    n = n.parentElement;
  }
  return n === from ? d : -1;
}

/** Status id whose link is closest to el in the tree (deepest LCA). */
function nearestStatusId(el, rootArticle) {
  if (!el || !rootArticle) return null;
  const elNode = el instanceof Element ? el : el.parentElement;
  if (!elNode) return null;
  let bestId = null;
  let bestDepth = -1;
  for (const a of rootArticle.querySelectorAll('a[href*="/status/"]')) {
    const id = a.href.match(/\/status\/(\d+)/)?.[1];
    if (!id) continue;
    const common = domLca(a, elNode, rootArticle);
    if (!common) continue;
    const depth = domDepth(rootArticle, common);
    if (depth > bestDepth) {
      bestDepth = depth;
      bestId = id;
    }
  }
  return bestId;
}

function findQuotedTweetRoot(rootArticle) {
  if (!rootArticle) return null;

  const byTestId = rootArticle.querySelector(
    '[data-testid="quoteTweet"], [data-testid="tweetQuote"]'
  );
  if (byTestId) return byTestId;

  const ownId = ownTweetIdFromTime(rootArticle);

  let quoteLink = null;
  for (const card of rootArticle.querySelectorAll('[role="link"]')) {
    if (card.querySelector?.('[role="group"]')) continue;
    const ids = [...card.querySelectorAll('a[href*="/status/"]')]
      .map((a) => a.href.match(/\/status\/(\d+)/)?.[1])
      .filter(Boolean);
    const foreign = ownId ? ids.find((id) => id !== ownId) : ids[0];
    if (!foreign) continue;
    if (
      card.querySelector(
        '[data-testid="tweetText"], [data-testid="tweetPhoto"], [data-testid="User-Name"], video, [data-testid="videoComponent"], [data-testid="videoPlayer"]'
      )
    ) {
      quoteLink = card;
      break;
    }
  }

  let foreignAnchor = null;
  for (const a of rootArticle.querySelectorAll('a[href*="/status/"]')) {
    const id = a.href.match(/\/status\/(\d+)/)?.[1];
    if (!id) continue;
    if (ownId && id === ownId) continue;
    foreignAnchor = a;
    break;
  }

  const seed = quoteLink || foreignAnchor;
  if (!seed) return null;

  let best = quoteLink || seed;
  for (const media of rootArticle.querySelectorAll(
    'video, [data-testid="tweetPhoto"], [data-testid="videoComponent"], [data-testid="videoPlayer"]'
  )) {
    const near = nearestStatusId(media, rootArticle);
    if (!near || (ownId && near === String(ownId))) continue;
    const common = domLca(seed, media, rootArticle);
    if (!common || common === rootArticle) continue;
    if (common.contains(best)) best = common;
    else if (!best.contains(common)) best = common;
  }
  return best;
}

/** True if el lives under a quoted-tweet card inside rootArticle. */
function isInsideQuotedTweet(el, rootArticle) {
  if (!el || !rootArticle) return false;

  let node = el instanceof Element ? el : el.parentElement;
  while (node && node !== rootArticle) {
    if (node.matches?.("article") && node !== rootArticle) return true;
    const testId = node.getAttribute?.("data-testid") || "";
    if (testId === "quoteTweet" || testId === "tweetQuote") return true;
    node = node.parentElement;
  }

  const quoteRoot = findQuotedTweetRoot(rootArticle);
  if (quoteRoot && (quoteRoot === el || quoteRoot.contains(el))) return true;

  // Nearest /status/ link wins — feed sibling quote video is closer to the
  // quoted permalink than to this card's own <time> link.
  const ownId = ownTweetIdFromTime(rootArticle);
  const near = nearestStatusId(el, rootArticle);
  if (near && ownId && String(near) !== String(ownId)) return true;
  return false;
}

function nearestArticle(el) {
  return el?.closest?.('article[data-testid="tweet"], article[role="article"]') || null;
}

// DOM heuristic -- own-tweet media only (ignore quoted cards / quote-only posts).
function hasMediaDom(article) {
  for (const sel of [
    '[data-testid="tweetPhoto"]',
    "video",
    '[data-testid="videoComponent"]',
    '[data-testid="videoPlayer"]',
  ]) {
    for (const el of article.querySelectorAll(sel)) {
      if (!isInsideQuotedTweet(el, article)) return true;
    }
  }
  return false;
}

/** Cache: tweetId -> boolean (parent has its own mediaDetails, not quote-only). */
const ownMediaPresence = new Map();

/**
 * Check whether THIS tweet has downloadable media.
 * Prefer syndication mediaDetails; if empty/tombstoned (common for NSFW), fall back to DOM.
 * Quote-only posts stay buttonless until/unless own media appears in the DOM.
 */
function articleHasOnlyQuoteMedia(article) {
  if (!article) return false;
  const ownId = ownTweetIdFromTime(article) || getTweetId(article);
  const medias = article.querySelectorAll(
    'video, [data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"]'
  );
  if (!medias.length) return false;
  for (const el of medias) {
    if (!isInsideQuotedTweet(el, article)) return false;
    // Extra feed check: nearest status must not be this tweet
    if (ownId) {
      const near = nearestStatusId(el, article);
      if (near && String(near) === String(ownId)) return false;
    }
  }
  return true;
}

async function parentHasOwnMedia(tweetId, article) {
  if (!tweetId) return false;

  // Text-only quote of a media post: never show a button (and never trust API/cache).
  if (articleHasOnlyQuoteMedia(article)) {
    ownMediaPresence.delete(tweetId);
    dlog("parentHasOwnMedia quote-only article", tweetId);
    return false;
  }

  if (ownMediaPresence.has(tweetId)) return ownMediaPresence.get(tweetId);

  const domOwn = hasMediaDom(article);
  if (domOwn) {
    ownMediaPresence.set(tweetId, true);
    return true;
  }

  // Quote card / foreign status present but no own DOM media → no button.
  // Do not fall through to GraphQL/syndication (those can confuse quote embeds).
  if (findQuotedTweetRoot(article) || articleHasOnlyQuoteMedia(article)) {
    dlog("parentHasOwnMedia quote present without own DOM media", tweetId);
    return false;
  }

  try {
    const res = await fetchMediaInfo(tweetId);
    const ok = (res?.items?.length ?? 0) > 0;
    if (ok) {
      // Re-check quote-only after async gap
      if (articleHasOnlyQuoteMedia(article)) return false;
      ownMediaPresence.set(tweetId, true);
      return true;
    }
    dlog("parentHasOwnMedia API empty, DOM fallback", tweetId);
  } catch (err) {
    dlog("parentHasOwnMedia API failed, DOM fallback", err);
  }

  return hasMediaDom(article);
}

function findShareButton(actionBar) {
  return (
    actionBar.querySelector('[data-testid="share"]') ||
    actionBar.querySelector('button[aria-label*="Share" i]') ||
    actionBar.querySelector('a[aria-label*="Share" i]') ||
    null
  );
}

function findBookmarkControl(root) {
  if (!root) return null;
  return (
    root.querySelector('[data-testid="bookmark"]') ||
    root.querySelector('[data-testid="removeBookmark"]') ||
    root.querySelector('[aria-label*="Bookmark" i]') ||
    null
  );
}

/**
 * Share's layout cell to insert before.
 * Always works without Bookmark. Bookmark is only used to detect a
 * bookmark+share *cluster* (same direct child of the action bar).
 */
function shareInsertTarget(shareBtn, actionBar) {
  if (!shareBtn || !actionBar) return null;

  // Climb to the direct child of the action bar that contains Share.
  let top = shareBtn;
  while (top.parentElement && top.parentElement !== actionBar) {
    top = top.parentElement;
  }
  if (top.parentElement !== actionBar) {
    return shareBtn.parentElement || shareBtn;
  }

  // Cluster case: that top cell also contains Bookmark -- sit beside Share's sub-cell.
  if (findBookmarkControl(top) && top.contains(shareBtn) && top !== shareBtn) {
    let cell = shareBtn;
    while (cell.parentElement && cell.parentElement !== top) {
      cell = cell.parentElement;
    }
    return cell.parentElement === top ? cell : shareBtn;
  }

  // Normal case: top is Share's own column (Bookmark is a sibling column, or absent).
  return top;
}

/** Keep download immediately left of Share. Returns the insert target. */
function ensureDownloadBeforeShare(wrapper, shareBtn, actionBar) {
  const target = shareInsertTarget(shareBtn, actionBar);
  if (!wrapper || !target || wrapper === target) return target;
  if (wrapper.nextElementSibling !== target) {
    try {
      target.insertAdjacentElement("beforebegin", wrapper);
    } catch (err) {
      dlog("reseating download failed", err);
      actionBar?.appendChild(wrapper);
    }
  }
  return target;
}

function copyColumnClasses(wrapper, target) {
  // Only copy layout classes from a column div -- never from <button>/svg.
  if (!wrapper || !target || target.tagName !== "DIV") return;
  const cls = typeof target.className === "string" ? target.className.trim() : "";
  if (!cls) return;
  wrapper.className = `${cls} xsave-harvester`;
}

/** True when this article is the focused post on /status/:id (not a reply under it). */
function isPrimaryStatusArticle(article) {
  const m = location.pathname.match(/\/status\/(\d+)/);
  if (!m) return false;
  const id = getTweetId(article);
  return !!(id && id === m[1]);
}

/**
 * Status/permalink only: lock SVG + hover disc to Share's live pixel size.
 * Feed must NOT use this -- em/class clone is correct there and px sync shrinks it.
 */
function applyStatusIconMetrics(btn, shareBtn) {
  const shareSvg = shareBtn?.querySelector?.("svg");
  const ourSvg = btn?.querySelector("svg");
  const wrap = btn?.querySelector(".xsave-harvester-icon-wrap");
  if (!shareSvg || !ourSvg) return false;

  const sr = shareSvg.getBoundingClientRect();
  if (sr.width < 8 || sr.height < 8) return false;

  ourSvg.style.width = `${sr.width}px`;
  ourSvg.style.height = `${sr.height}px`;

  let node = shareSvg.parentElement;
  for (let i = 0; i < 5 && node; i++) {
    const r = node.getBoundingClientRect();
    if (
      r.width >= sr.width * 1.35 &&
      r.width <= sr.width * 3 &&
      Math.abs(r.width - r.height) < 8
    ) {
      if (wrap) {
        wrap.style.width = `${r.width}px`;
        wrap.style.height = `${r.height}px`;
      }
      break;
    }
    node = node.parentElement;
  }
  return true;
}

function scheduleStatusIconSync(btn, shareBtn) {
  const sync = () => applyStatusIconMetrics(btn, shareBtn);
  sync();
  requestAnimationFrame(() => {
    sync();
    requestAnimationFrame(sync);
  });
  // Status action bar often reflows after media/chrome settle.
  setTimeout(sync, 120);
  setTimeout(sync, 400);
}

function createDownloadButton(tweetId, article, shareBtn) {
  // Own button -- do not clone or alter X's share control.
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "xsave-harvester-btn twitterdl-btn";
  btn.title = "Download media";
  btn.setAttribute("aria-label", "Download media");
  btn.setAttribute("role", "button");

  // Feed: inherit Share font-size so 1.25em matches. Status: px sync handles size.
  if (shareBtn && !isPrimaryStatusArticle(article)) {
    const fs = getComputedStyle(shareBtn).fontSize;
    if (fs) btn.style.fontSize = fs;
  }

  const iconWrap = document.createElement("div");
  iconWrap.className = "xsave-harvester-icon-wrap";
  const bg = document.createElement("div");
  bg.className = "xsave-harvester-bg";
  iconWrap.appendChild(bg);
  iconWrap.appendChild(buildDownloadSvg(shareBtn));
  btn.appendChild(iconWrap);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    handleDownload(tweetId, btn, article);
  });

  return btn;
}

function syncHarvesterViewMode(wrapper, article, shareBtn) {
  if (!wrapper) return;
  const statusPrimary = isPrimaryStatusArticle(article);
  wrapper.classList.toggle("xsave-harvester--status", statusPrimary);
  wrapper.classList.toggle("xsave-harvester--feed", !statusPrimary);
  const btn = wrapper.querySelector(".xsave-harvester-btn");
  if (btn) {
    btn.classList.toggle("xsave-harvester-btn--status", statusPrimary);
    if (!statusPrimary) {
      // Clear status px locks so feed em sizing works again.
      const svg = btn.querySelector("svg");
      const wrap = btn.querySelector(".xsave-harvester-icon-wrap");
      if (svg) {
        svg.style.removeProperty("width");
        svg.style.removeProperty("height");
      }
      if (wrap) {
        wrap.style.removeProperty("width");
        wrap.style.removeProperty("height");
      }
      if (shareBtn) {
        const fs = getComputedStyle(shareBtn).fontSize;
        if (fs) btn.style.fontSize = fs;
      }
    } else {
      scheduleStatusIconSync(btn, shareBtn);
    }
  }
}

function injectButton(article, tweetId) {
  const actionBar = article.querySelector('[role="group"]');
  if (!actionBar) return;

  const shareBtn = findShareButton(actionBar);
  const target = shareInsertTarget(shareBtn, actionBar);
  const statusPrimary = isPrimaryStatusArticle(article);

  // Prefer in-bar control; drop orphans left over from SPA remounts.
  let existing = actionBar.querySelector(".xsave-harvester");
  if (!existing) {
    const orphan = article.querySelector(".xsave-harvester");
    if (orphan && !actionBar.contains(orphan)) orphan.remove();
  } else {
    syncHarvesterViewMode(existing, article, shareBtn);
    ensureDownloadBeforeShare(existing, shareBtn, actionBar);
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "xsave-harvester";
  copyColumnClasses(wrapper, target);
  wrapper.classList.add(statusPrimary ? "xsave-harvester--status" : "xsave-harvester--feed");

  const btn = createDownloadButton(tweetId, article, shareBtn);
  if (statusPrimary) btn.classList.add("xsave-harvester-btn--status");
  wrapper.appendChild(btn);

  if (target) {
    ensureDownloadBeforeShare(wrapper, shareBtn, actionBar);
  } else {
    actionBar.appendChild(wrapper);
  }

  if (statusPrimary) {
    scheduleStatusIconSync(btn, shareBtn);
  }
}

// Fallback: own-tweet media only (skip quoted cards).
function bestFromSrcset(srcset) {
  if (!srcset) return "";
  let best = "";
  let bestScore = -1;
  for (const part of String(srcset).split(",")) {
    const bits = part.trim().split(/\s+/);
    const url = bits[0] || "";
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) continue;
    const desc = bits[1] || "";
    let score = 0;
    const w = desc.match(/^(\d+)w$/i);
    const x = desc.match(/^([\d.]+)x$/i);
    if (w) score = parseInt(w[1], 10);
    else if (x) score = parseFloat(x[1]) * 1000;
    else if (/name=orig/i.test(url)) score = 1e9;
    else if (/name=large/i.test(url)) score = 1e8;
    else if (/name=medium/i.test(url)) score = 1e7;
    if (score >= bestScore) {
      bestScore = score;
      best = url;
    }
  }
  return best;
}

function normalizePhotoUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url, location.href);
    if (!/\.twimg\.com$/i.test(u.hostname) && u.hostname !== "pbs.twimg.com") {
      if (!u.hostname.endsWith(".twimg.com")) return url;
    }
    // Force original when it's a media CDN image
    if (u.hostname.includes("pbs.twimg.com") || /\/media\//i.test(u.pathname)) {
      u.searchParams.set("name", "orig");
      return u.toString();
    }
    return u.toString();
  } catch {
    return url;
  }
}

function scrapeCdnUrlsFromHtml(article) {
  const html = article?.innerHTML || "";
  const found = [];
  const re = /https:\/\/(?:video|pbs)\.twimg\.com\/[^"'\\\s<>]+/gi;
  let m;
  while ((m = re.exec(html))) {
    found.push(m[0].replace(/&amp;/g, "&"));
  }
  return found;
}

/** URLs this tab already fetched -- often the only handle on NSFW when syndication tombstones. */
function scrapeLoadedTwimgUrls() {
  try {
    return performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((u) => /^https:\/\/(video|pbs)\.twimg\.com\//i.test(u));
  } catch {
    return [];
  }
}


/** tweetId -> media items captured from React props / later hooks */
const hookedMediaByTweet = new Map();

function rememberHookedMedia(tweetId, items) {
  if (!tweetId || !items?.length) return;
  const id = String(tweetId);
  const prev = hookedMediaByTweet.get(id) || [];
  const seen = new Set(prev.map((i) => i.url));
  const merged = prev.slice();
  for (const it of items) {
    if (!it?.url || seen.has(it.url)) continue;
    seen.add(it.url);
    merged.push(it);
  }
  hookedMediaByTweet.set(id, merged);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "xsave-media-hook") return;
  if (data.type === "MEDIA" && data.tweetId && Array.isArray(data.items)) {
    rememberHookedMedia(data.tweetId, data.items);
  }
});

function getFiber(node) {
  if (!node) return null;
  for (const k of Object.keys(node)) {
    if (k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")) {
      return node[k];
    }
  }
  return null;
}

function mediaItemFromEntity(media) {
  if (!media || typeof media !== "object") return null;
  const type = media.type || media.media_type || "";
  const preview = media.media_url_https || media.media_url || "";
  if (type === "video" || type === "animated_gif") {
    const variants = media.video_info?.variants || [];
    const mp4s = variants
      .filter((v) => v.content_type === "video/mp4" && v.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (!mp4s.length) return null;
    return {
      type: type === "animated_gif" ? "animated_gif" : "video",
      url: mp4s[0].url,
      preview,
      label: type === "animated_gif" ? "GIF" : "Video",
    };
  }
  if (type === "photo" || /pbs\.twimg\.com\/media/i.test(preview)) {
    const base = String(preview || "").split("?")[0];
    if (!base) return null;
    const extMatch = base.match(/\.([a-z0-9]+)$/i);
    return {
      type: "photo",
      url: base.includes("?") ? `${base.split("?")[0]}?name=orig` : `${base}?name=orig`,
      ext: extMatch ? extMatch[1].toLowerCase() : "jpg",
      preview,
      label: "Image",
    };
  }
  return null;
}

function collectMediaListsFromProps(props) {
  if (!props || typeof props !== "object") return [];
  const lists = [];
  const candidates = [
    props.mediaDetails,
    props.extended_entities?.media,
    props.legacy?.extended_entities?.media,
    props.entities?.media,
    props.mediaEntities,
    props.tweet?.legacy?.extended_entities?.media,
    props.tweet?.extended_entities?.media,
    props.itemContent?.tweet_results?.result?.legacy?.extended_entities?.media,
    props.itemContent?.tweet_results?.result?.tweet?.legacy?.extended_entities?.media,
    props.content?.itemContent?.tweet_results?.result?.legacy?.extended_entities?.media,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) lists.push(c);
  }
  return lists;
}

function extractMediaFromReact(article, tweetId) {
  const items = [];
  const seen = new Set();
  const roots = [
    article,
    article.querySelector('[data-testid="tweetPhoto"]'),
    article.querySelector("video"),
    article.querySelector('[data-testid="videoPlayer"]'),
    article.querySelector('[data-testid="videoComponent"]'),
  ].filter(Boolean);

  for (const root of roots) {
    let fiber = getFiber(root);
    let hops = 0;
    while (fiber && hops < 40) {
      hops++;
      for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
        for (const list of collectMediaListsFromProps(props)) {
          for (const media of list) {
            const item = mediaItemFromEntity(media);
            if (item?.url && !seen.has(item.url)) {
              seen.add(item.url);
              items.push(item);
            }
          }
        }
        // Deep-ish search for video_info on nested props (bounded)
        try {
          const raw = JSON.stringify(props);
          if (raw && /video_info|media_url_https|extended_entities/.test(raw) && raw.length < 2_000_000) {
            const reUrl = /https:\\\/\\\/video\.twimg\.com\\\/[^"\\]+/g;
            let m;
            while ((m = reUrl.exec(raw))) {
              const url = m[0].replace(/\\\//g, "/").replace(/\\u002F/g, "/");
              if (!seen.has(url) && !/\.m3u8(\?|$)/i.test(url)) {
                seen.add(url);
                items.push({
                  type: /tweet_video/i.test(url) ? "animated_gif" : "video",
                  url,
                  preview: "",
                  label: /tweet_video/i.test(url) ? "GIF" : "Video",
                });
              }
            }
            const rePhoto = /https:\\\/\\\/pbs\.twimg\.com\\\/media\\\/[^"\\]+/g;
            while ((m = rePhoto.exec(raw))) {
              let url = m[0].replace(/\\\//g, "/").replace(/\\u002F/g, "/");
              url = url.split("?")[0] + "?name=orig";
              if (!seen.has(url)) {
                seen.add(url);
                const extMatch = url.split("?")[0].match(/\.([a-z0-9]+)$/i);
                items.push({
                  type: "photo",
                  url,
                  ext: extMatch ? extMatch[1].toLowerCase() : "jpg",
                  preview: url,
                  label: "Image",
                });
              }
            }
          }
        } catch (_) {}
      }
      fiber = fiber.return;
    }
  }

  if (items.length && tweetId) rememberHookedMedia(tweetId, items);
  dlog("React media items", { tweetId, count: items.length, items });
  return items;
}
function allCdnCandidates(article) {
  const out = [];
  const seen = new Set();
  for (const u of [...scrapeCdnUrlsFromHtml(article), ...scrapeLoadedTwimgUrls()]) {
    const clean = String(u).replace(/&amp;/g, "&");
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function extractMediaFromDom(article) {
  const items = [];
  const seen = new Set();

  const push = (item) => {
    const key = `${item.type}|${item.url || item.preview || item.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const video of article.querySelectorAll("video")) {
    if (isInsideQuotedTweet(video, article)) continue;
    const src =
      video.currentSrc ||
      video.src ||
      video.querySelector("source")?.src ||
      "";
    if (src && !src.startsWith("blob:")) {
      const isGif = /tweet_video/i.test(src);
      push({
        type: isGif ? "animated_gif" : "video",
        url: src,
        preview: video.poster || "",
        label: isGif ? "GIF" : "Video",
      });
    } else {
      // blob: / empty -- try poster + HTML scrape for a real CDN mp4 later
      push({
        type: "video",
        url: "",
        needsResolve: true,
        preview: video.poster || "",
        label: "Video",
      });
    }
  }

  for (const img of article.querySelectorAll(
    '[data-testid="tweetPhoto"] img, [data-testid="tweetPhoto"] image, article img[src*="pbs.twimg.com/media"], article img[srcset*="pbs.twimg.com/media"]'
  )) {
    if (isInsideQuotedTweet(img, article)) continue;
    if (
      img.closest("video") ||
      img.closest('[data-testid="videoComponent"], [data-testid="videoPlayer"]')
    ) {
      continue;
    }
    const raw =
      bestFromSrcset(img.getAttribute("srcset")) ||
      img.currentSrc ||
      img.src ||
      img.getAttribute("data-src") ||
      "";
    if (!raw || raw.startsWith("blob:") || raw.startsWith("data:")) continue;
    if (!/twimg\.com/i.test(raw)) continue;
    const url = normalizePhotoUrl(raw);
    const path = url.split("?")[0];
    const extMatch = path.match(/\.([a-z0-9]+)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
    push({
      type: "photo",
      url,
      ext,
      preview: raw,
      label: "Image",
    });
  }

  // Last resort: pull CDN URLs embedded in markup (common when players use blob:)
  if (!items.some((i) => i.url && !i.url.startsWith("blob:"))) {
    for (const cdn of allCdnCandidates(article)) {
      if (/video\.twimg\.com/i.test(cdn)) {
        const isGif = /tweet_video/i.test(cdn);
        push({
          type: isGif ? "animated_gif" : "video",
          url: cdn,
          preview: "",
          label: isGif ? "GIF" : "Video",
        });
      } else if (/pbs\.twimg\.com\/media/i.test(cdn)) {
        const url = normalizePhotoUrl(cdn);
        const path = url.split("?")[0];
        const extMatch = path.match(/\.([a-z0-9]+)$/i);
        push({
          type: "photo",
          url,
          ext: extMatch ? extMatch[1].toLowerCase() : "jpg",
          preview: cdn,
          label: "Image",
        });
      }
    }
  }

  // Fill empty needsResolve videos from scraped mp4s
  const scrapedMp4s = allCdnCandidates(article).filter((u) =>
    /video\.twimg\.com/i.test(u) && !/\.m3u8(\?|$)/i.test(u)
  );
  if (scrapedMp4s.length) {
    for (const item of items) {
      if (
        (item.type === "video" || item.type === "animated_gif") &&
        (!item.url || item.url.startsWith("blob:") || item.needsResolve)
      ) {
        const pick =
          scrapedMp4s.find((u) => /tweet_video/i.test(u)) || scrapedMp4s[0];
        item.url = pick;
        item.type = /tweet_video/i.test(pick) ? "animated_gif" : item.type;
        delete item.needsResolve;
      }
    }
  }

  dlog("DOM fallback items", items);
  return items;
}


function mediaDedupeKey(item) {
  const raw = item?.url || item?.preview || "";
  if (!raw || String(raw).startsWith("blob:")) {
    return `blob:${item?.type || "x"}:${item?.preview || ""}`;
  }
  try {
    const u = new URL(String(raw).replace(/&amp;/g, "&"));
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    if (host.includes("video.twimg.com")) return `video:${path}`;
    if (host.includes("pbs.twimg.com")) return `photo:${path}`;
    return `${host}${path}`;
  } catch {
    return String(raw).split("?")[0];
  }
}

function dedupeMediaItems(items) {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    if (!it) continue;
    const key = mediaDedupeKey(it);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  const hasRealVideo = out.some(
    (i) => (i.type === "video" || i.type === "animated_gif") && i.url && !String(i.url).startsWith("blob:")
  );
  return out.filter((i) => !(i.needsResolve && hasRealVideo));
}

function enrichItems(items) {
  return (items || []).map((item, i) => ({
    ...item,
    label:
      item.label ||
      (item.type === "animated_gif"
        ? "GIF"
        : item.type === "video"
          ? "Video"
          : `Image ${i + 1}`),
    preview: item.preview || (item.type === "photo" ? item.url : ""),
  }));
}

const DEFAULT_SETTINGS = {
  gifEnabled: true,
  gifQuality: "medium",
  filenameTemplate: "{username}_{tweetid}",
};

let settingsCache = null;

function getSettings() {
  if (settingsCache) return Promise.resolve(settingsCache);
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (result) => {
      settingsCache = result;
      resolve(result);
    });
  });
}

chrome.storage.onChanged.addListener(() => { settingsCache = null; });

function buildFilename(template, { username, tweetId, type, index, total }) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const typeStr = type === "animated_gif" ? "gif" : type;

  let name = template
    .replace(/{username}/g, username || "unknown")
    .replace(/{tweetid}/g, tweetId)
    .replace(/{date}/g, date)
    .replace(/{type}/g, typeStr)
    .replace(/{index}/g, total > 1 ? String(index + 1) : "");

  if (total > 1 && !template.includes("{index}")) {
    name += `_${index + 1}`;
  }

  const cleaned = name
    .replace(/\.\./g, "_")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 180);
  if (cleaned) return cleaned;
  return tweetId ? `x_${tweetId}` : `x_${Date.now()}`;
}

async function collectOwnMedia(tweetId, article) {
  const response = await fetchMediaInfo(tweetId);
  let items = enrichItems(response?.items ?? []);

  const reactItems = article ? enrichItems(extractMediaFromReact(article, tweetId)) : [];
  const hookedItems = enrichItems(hookedMediaByTweet.get(String(tweetId)) || []);
  const domItems = article ? enrichItems(extractMediaFromDom(article)) : [];

  const mergeIn = (extra) => {
    if (!extra?.length) return;
    const seen = new Set(items.map((i) => i.url).filter(Boolean));
    for (const it of extra) {
      if (!it?.url || it.url.startsWith("blob:") || seen.has(it.url)) continue;
      seen.add(it.url);
      items.push(it);
    }
  };

  if (items.length === 0) {
    items = [...hookedItems, ...reactItems, ...domItems];
    // de-dupe
    const seen = new Set();
    items = items.filter((it) => {
      if (!it?.url || it.url.startsWith("blob:")) return !!it?.needsResolve;
      if (seen.has(it.url)) return false;
      seen.add(it.url);
      return true;
    });
  } else {
    mergeIn(hookedItems);
    mergeIn(reactItems);
    const apiHasVideo = items.some((i) => i.type === "video" || i.type === "animated_gif");
    const domVideo = domItems.filter((i) => i.type === "video" || i.type === "animated_gif");
    if (!apiHasVideo && domVideo.length) mergeIn(domVideo);
  }

  // Drop empty unresolved placeholders when we already have a real video URL
  const hasRealVideo = items.some(
    (i) => (i.type === "video" || i.type === "animated_gif") && i.url && !i.url.startsWith("blob:")
  );
  items = items.filter((i) => {
    if (i.needsResolve && hasRealVideo) return false;
    return true;
  });

  return dedupeMediaItems(items);
}


function parseRgb(color) {
  if (!color) return null;
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3] };
}

/** Match X themes: light | dim (#15202b) | lights-out (#000). */
function detectXTheme() {
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  const rgb = parseRgb(bodyBg) || parseRgb(htmlBg);
  if (!rgb) {
    const scheme = getComputedStyle(document.documentElement).colorScheme || "";
    return scheme.includes("dark") ? "dim" : "light";
  }
  const { r, g, b } = rgb;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (luminance > 0.7) return "light";
  // Near-black = lights out; blue-gray dim is ~21,32,43
  if (r <= 20 && g <= 20 && b <= 20) return "lights-out";
  return "dim";
}

function showMediaPicker(items) {
  return new Promise((resolve) => {
    document.getElementById("xsave-picker")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "xsave-picker";
    overlay.dataset.xTheme = detectXTheme();
    overlay.innerHTML = `
      <div class="xsave-picker-card" role="dialog" aria-label="Choose media to download">
        <div class="xsave-picker-header">
          <div class="xsave-picker-title">Download</div>
          <button type="button" class="xsave-picker-close" data-act="cancel" aria-label="Close">×</button>
        </div>
        <div class="xsave-picker-list"></div>
        <div class="xsave-picker-actions">
          <button type="button" class="xsave-picker-btn ghost" data-act="all">All</button>
          <button type="button" class="xsave-picker-btn primary" data-act="selected">Download</button>
        </div>
      </div>`;

    const list = overlay.querySelector(".xsave-picker-list");
    items.forEach((item, i) => {
      const row = document.createElement("label");
      row.className = "xsave-picker-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.idx = String(i);

      if (item.preview && /^https:\/\/(?:pbs|video)\.twimg\.com\//i.test(item.preview)) {
        const img = document.createElement("img");
        img.className = "xsave-picker-thumb";
        img.alt = "";
        img.referrerPolicy = "no-referrer";
        img.src = item.preview;
        row.append(cb, img);
      } else {
        const ph = document.createElement("div");
        ph.className = "xsave-picker-thumb xsave-picker-thumb-empty";
        ph.textContent = item.type === "video" || item.type === "animated_gif" ? "▶" : "IMG";
        row.append(cb, ph);
      }

      const label = document.createElement("span");
      label.className = "xsave-picker-label";
      label.textContent = `${item.label || "Media"}${items.length > 1 ? ` · ${i + 1}` : ""}`;
      row.appendChild(label);
      list.appendChild(row);
    });

    const finish = (selected) => {
      overlay.remove();
      resolve(selected);
    };

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    overlay.querySelector('[data-act="cancel"]').onclick = () => finish(null);
    overlay.querySelector('[data-act="all"]').onclick = () => finish(items.slice());
    overlay.querySelector('[data-act="selected"]').onclick = () => {
      const idxs = [...overlay.querySelectorAll("input[type=checkbox]:checked")].map(
        (el) => Number(el.dataset.idx)
      );
      finish(items.filter((_, i) => idxs.includes(i)));
    };

    document.addEventListener(
      "keydown",
      function esc(e) {
        if (e.key === "Escape") {
          document.removeEventListener("keydown", esc, true);
          finish(null);
        }
      },
      true
    );

    document.body.appendChild(overlay);
  });
}

async function downloadItems(items, tweetId, article, btn, settings) {
  const username = getTweetUsername(article);
  const total = items.length;

  for (let i = 0; i < items.length; i++) {
    let item = items[i];

    // Resolve blob / empty video URLs: syndication first, then DOM/HTML scrape
    if (
      (item.type === "video" || item.type === "animated_gif") &&
      (!item.url || item.url.startsWith("blob:") || item.needsResolve)
    ) {
      try {
        const info = await fetchMediaInfo(tweetId);
        const vids = (info?.items ?? []).filter(
          (x) => x.type === "video" || x.type === "animated_gif"
        );
        if (vids[0]?.url) {
          item = { ...item, url: vids[0].url, type: vids[0].type };
        }
      } catch (err) {
        dlog("downloadItems syndication resolve failed", err);
      }
      if (!item.url || item.url.startsWith("blob:")) {
        const hooked = enrichItems(hookedMediaByTweet.get(String(tweetId)) || []);
        const reactAgain = article ? enrichItems(extractMediaFromReact(article, tweetId)) : [];
        const domAgain = enrichItems(extractMediaFromDom(article));
        const pool = [...hooked, ...reactAgain, ...domAgain];
        const vids = pool.filter(
          (x) =>
            (x.type === "video" || x.type === "animated_gif") &&
            x.url &&
            !x.url.startsWith("blob:")
        );
        if (vids[0]?.url) {
          item = { ...item, url: vids[0].url, type: vids[0].type };
        }
      }
    }

    if (!item.url || item.url.startsWith("blob:")) {
      showToast("Could not get a direct media URL (NSFW may block syndication). Try right-click Save as GIF on the video, or reload after revealing media.");
      continue;
    }

    const filename = buildFilename(settings.filenameTemplate, {
      username,
      tweetId,
      type: item.type,
      index: i,
      total,
    });

    if (item.type === "animated_gif") {
      btn.classList.remove("twitterdl-loading", "xsave-downloading");
      await downloadGifViaPipeline(item.url, filename, tweetId, btn);
    } else if (item.type === "video") {
      triggerDownload(item.url, filename, "mp4");
    } else if (item.type === "photo") {
      triggerDownload(item.url, filename, item.ext || "jpg");
    }
  }
}

async function handleDownload(tweetId, btn, article) {
  btn.classList.add("twitterdl-loading", "xsave-downloading");

  try {
    const [itemsRaw, settings] = await Promise.all([
      collectOwnMedia(tweetId, article),
      getSettings(),
    ]);

    let items = itemsRaw;
    if (items.length === 0) {
      showToast("❌ Could not find downloadable media.");
      return;
    }

    if (items.length > 1) {
      btn.classList.remove("twitterdl-loading", "xsave-downloading");
      const picked = await showMediaPicker(items);
      if (!picked || picked.length === 0) return;
      items = picked;
      btn.classList.add("twitterdl-loading", "xsave-downloading");
    }

    await downloadItems(items, tweetId, article, btn, settings);

    btn.classList.add("twitterdl-done", "xsave-done");
    setTimeout(() => btn.classList.remove("twitterdl-done", "xsave-done"), 2000);
  } catch (err) {
    console.error("[XFetch]", err);
    showToast(`❌ ${err?.message ?? "Download failed"}`);
  } finally {
    btn.classList.remove("twitterdl-loading", "xsave-downloading");
    btn.classList.remove("twitterdl-progress", "xsave-progress");
  }
}

function restoreButton(btn) {
  btn.classList.remove("twitterdl-progress", "xsave-progress", "xsave-downloading", "xsave-error");
  // Prefer restoring SVG inside existing wrap
  const wrap = btn.querySelector(".xsave-harvester-icon-wrap") || btn;
  const existingSvg = btn.querySelector("svg");
  if (existingSvg) {
    existingSvg.innerHTML = BTN_SVG_INNER;
  } else {
    const bg = wrap.querySelector(".xsave-harvester-bg");
    wrap.querySelector(".xsave-harvester-pct")?.remove();
    if (!bg) {
      wrap.insertAdjacentHTML("afterbegin", '<div class="xsave-harvester-bg"></div>');
    }
    if (!wrap.querySelector("svg")) wrap.insertAdjacentHTML("beforeend", BTN_SVG);
  }
  btn.querySelector(".xsave-harvester-pct")?.remove();
  btn.style.fontSize = "";
}

function looksLikeGifUrl(url) {
  return !!(url && /tweet_video/i.test(url));
}

function pickGifOrVideoUrl(items) {
  if (!items?.length) return null;
  const gif = items.find((i) => i.type === "animated_gif" && i.url);
  if (gif) return { url: gif.url, forceGif: true };
  const vid = items.find(
    (i) => (i.type === "video" || i.type === "animated_gif") && i.url
  );
  if (vid) return { url: vid.url, forceGif: vid.type === "animated_gif" || looksLikeGifUrl(vid.url) };
  return null;
}

async function resolveVideoMp4() {
  const article = lastContextArticle || (lastContextVideo && nearestArticle(lastContextVideo));
  const tweetId =
    lastContextTweetId || (article ? getTweetId(article) : null);

  // 1) Direct DOM src on the remembered video (non-blob)
  if (lastContextVideo) {
    const direct =
      lastContextVideo.currentSrc ||
      lastContextVideo.src ||
      lastContextVideo.querySelector("source")?.src ||
      "";
    if (direct && !direct.startsWith("blob:")) {
      return {
        ok: true,
        url: direct,
        tweetId,
        forceGif: looksLikeGifUrl(direct),
      };
    }
  }

  // 2) Any non-blob video in the article
  if (article) {
    const fromDom = extractMediaFromDom(article);
    const picked = pickGifOrVideoUrl(fromDom);
    if (picked) {
      return { ok: true, url: picked.url, tweetId, forceGif: picked.forceGif };
    }
  }

  // 3) Syndication via background FETCH_MEDIA_URL
  if (tweetId) {
    const response = await fetchMediaInfo(tweetId);
    const items = response?.items ?? [];
    const picked = pickGifOrVideoUrl(items);
    if (picked) {
      return { ok: true, url: picked.url, tweetId, forceGif: true };
    }
  }

  // 4) Poster / data attributes sometimes expose media ids -- last resort scan
  if (article) {
    const poster = article.querySelector("video[poster]")?.getAttribute("poster") || "";
    // Poster alone isn't an MP4; try video.twimg links in the article HTML
    const html = article.innerHTML || "";
    const m = html.match(/https:\/\/video\.twimg\.com\/[^"'\\\s]+/i);
    if (m) {
      const url = m[0].replace(/&amp;/g, "&");
      return {
        ok: true,
        url,
        tweetId,
        forceGif: looksLikeGifUrl(url) || !!poster,
      };
    }
  }

  return {
    ok: false,
    error: "Could not resolve MP4 URL (blob src and no syndication/DOM fallback)",
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GIF_PROGRESS") {
    const btn = activeGifDownloads.get(msg.tweetId);
    if (!btn) return;
    const pct = Math.round(msg.progress * 100);
    btn.classList.add("twitterdl-progress", "xsave-progress");
    btn.querySelector("svg")?.remove();
    let pctEl = btn.querySelector(".xsave-harvester-pct, .twitterdl-pct");
    if (!pctEl) {
      pctEl = document.createElement("span");
      pctEl.className = "xsave-harvester-pct twitterdl-pct";
      (btn.querySelector(".xsave-harvester-icon-wrap") || btn).appendChild(pctEl);
    }
    pctEl.textContent = `${pct}%`;
    return;
  }

  if (msg.type === "RESOLVE_VIDEO_MP4") {
    resolveVideoMp4()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

function isLikelyGifMedia(video, article) {
  if (!video) return false;
  const src =
    video.currentSrc ||
    video.src ||
    video.querySelector("source")?.src ||
    "";
  if (looksLikeGifUrl(src)) return true;

  const root = article || video.closest?.('[data-testid="videoComponent"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"]') || video.parentElement;
  if (!root) return false;

  if (root.querySelector?.('[data-testid="gifBadge"], [aria-label="GIF"], [aria-label*="GIF" i]')) {
    return true;
  }

  // X paints a small "GIF" chip on the media; keep the scan local to the player.
  const chip = root.querySelector?.("div, span");
  const localText = (root.innerText || root.textContent || "").trim();
  if (/^GIF$/m.test(localText) || /(^|\n)\s*GIF\s*(\n|$)/.test(localText)) {
    return true;
  }
  // Avoid matching "GIF" inside tweet body: only look at short overlay nodes
  for (const el of root.querySelectorAll("div, span")) {
    const s = (el.childNodes.length === 1 && el.textContent || "").trim();
    if (s === "GIF") return true;
  }

  // Classic X GIF player: looping, muted, no scrubber controls
  if (video.loop && video.muted && !video.controls) {
    const hasSeekBar = root.querySelector?.('[data-testid="videoProgressBar"], progress, input[type="range"]');
    if (!hasSeekBar) return true;
  }
  return false;
}

function hideSaveGifMenu() {
  document.getElementById("xsave-gif-menu")?.remove();
}

/** Same theme tokens as the multi-select picker (light / dim / lights-out). */
function showSaveGifMenu(clientX, clientY, onSave) {
  hideSaveGifMenu();
  const menu = document.createElement("div");
  menu.id = "xsave-gif-menu";
  menu.setAttribute("role", "menu");
  menu.dataset.xTheme = detectXTheme();

  const item = document.createElement("button");
  item.type = "button";
  item.className = "xsave-gif-menu-item";
  item.setAttribute("role", "menuitem");
  item.textContent = "Save as GIF";
  item.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    hideSaveGifMenu();
    onSave();
  });
  menu.appendChild(item);
  document.body.appendChild(menu);

  const pad = 8;
  const rect = menu.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + rect.width > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (top + rect.height > window.innerHeight - pad) {
    top = Math.max(pad, window.innerHeight - rect.height - pad);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const dismiss = (ev) => {
    if (menu.contains(ev.target)) return;
    hideSaveGifMenu();
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("scroll", dismiss, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") dismiss(ev);
  };
  setTimeout(() => {
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("scroll", dismiss, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

/**
 * One GIF pipeline for the action-bar button and the right-click menu.
 * (DOWNLOAD_AS_GIF â†’ convertToGif â†’ offscreen encode â†’ SW chrome.downloads)
 */
async function downloadGifViaPipeline(url, filename, tweetId, btn = null) {
  showToast("⏳ Converting to GIF…");
  if (btn && tweetId) activeGifDownloads.set(tweetId, btn);
  try {
    await convertAndDownloadGif(url, filename, tweetId);
    showToast("✓ GIF saved");
  } finally {
    if (tweetId) activeGifDownloads.delete(tweetId);
    if (btn) restoreButton(btn);
  }
}

async function saveGifFromContext() {
  try {
    const settings = await getSettings();
    const article = lastContextArticle;
    const tweetId = lastContextTweetId || (article ? getTweetId(article) : null);
    const username = article ? getTweetUsername(article) : "unknown";

    let url = null;
    let forceGif = true;

    if (lastContextVideo) {
      const direct =
        lastContextVideo.currentSrc ||
        lastContextVideo.src ||
        lastContextVideo.querySelector("source")?.src ||
        "";
      if (direct && !direct.startsWith("blob:")) {
        url = direct;
        forceGif = looksLikeGifUrl(direct) || forceGif;
      }
    }

    if (!url) {
      const resolved = await resolveVideoMp4();
      if (!resolved?.ok || !resolved.url) {
        throw new Error(resolved?.error || "Could not find GIF media");
      }
      url = resolved.url;
      forceGif = resolved.forceGif !== false;
    }

    const filename = buildFilename(settings.filenameTemplate, {
      username,
      tweetId: tweetId || String(Date.now()),
      type: "animated_gif",
      index: 0,
      total: 1,
    });

    if (forceGif || looksLikeGifUrl(url)) {
      await downloadGifViaPipeline(url, filename, tweetId, null);
    } else {
      triggerDownload(url, filename, "mp4");
      showToast("Saved as MP4 (not a GIF source)");
    }
  } catch (err) {
    console.error("[XFetch] saveGifFromContext", err);
    showToast(`❌ ${err?.message ?? "Save failed"}`);
  }
}

// X replaces the browser menu with "Copy gif address" -- take over GIF right-clicks.
document.addEventListener(
  "contextmenu",
  (e) => {
    // Shift+right-click â†’ leave the native / site menu alone
    if (e.shiftKey) return;

    const video = e.target?.closest?.("video");
    const mediaRoot =
      e.target?.closest?.(
        '[data-testid="videoComponent"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"]'
      ) || null;
    const hit = video || mediaRoot?.querySelector?.("video") || null;
    if (!hit && !mediaRoot) return;

    const article = nearestArticle(hit || e.target);
    lastContextVideo = hit || article?.querySelector("video") || null;
    lastContextArticle = article;
    lastContextTweetId = article ? getTweetId(article) : null;

    // Prefer clear GIF signals; also treat looped muted tweet_video-less players
    // that X labels as GIF (badge / aria) -- never hijack normal videos.
    const gif = isLikelyGifMedia(lastContextVideo, mediaRoot || article);

    if (!gif || !lastContextVideo) {
      dlog("contextmenu skip (not gif)", { tweetId: lastContextTweetId });
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

    dlog("contextmenu Save as GIF menu", { tweetId: lastContextTweetId });
    showSaveGifMenu(e.clientX, e.clientY, () => {
      saveGifFromContext();
    });
  },
  true
);

function fetchMediaInfo(tweetId) {
  return sendMessage({ type: "FETCH_MEDIA_URL", tweetId });
}

function triggerDownload(url, filename, ext) {
  chrome.runtime.sendMessage({ type: "DOWNLOAD_FILE", url, filename, ext });
}

function convertAndDownloadGif(url, filename, tweetId) {
  return sendMessage({ type: "DOWNLOAD_AS_GIF", url, filename, tweetId }).then((res) => {
    if (!res?.ok) throw new Error(res?.error ?? "Conversion failed");
  });
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime?.id) {
      reject(new Error("Reload the page to reconnect the extension."));
      return;
    }
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

function showToast(message) {
  const existing = document.getElementById("twitterdl-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "twitterdl-toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

let processGen = 0;

async function processTweets() {
  const gen = ++processGen;
  const articles = [
    ...document.querySelectorAll(
      'article[data-testid="tweet"], article[role="article"]'
    ),
  ];

  for (const article of articles) {
    if (gen !== processGen) return;

    const tweetId = getTweetId(article);
    const actionBar = article.querySelector('[role="group"]');
    let existing = actionBar?.querySelector(".xsave-harvester") || null;
    const orphan = article.querySelector(".xsave-harvester");
    if (orphan && actionBar && !actionBar.contains(orphan)) {
      orphan.remove();
    }
    if (!existing) existing = actionBar?.querySelector(".xsave-harvester") || null;

    if (!tweetId) {
      if (existing) {
        existing.remove();
        article.removeAttribute(PROCESSED_ATTR);
      }
      continue;
    }

    // Prefer syndication (empty mediaDetails => quote-only / text-only)
    const shouldHave = await parentHasOwnMedia(tweetId, article);
    if (gen !== processGen) return;

    if (shouldHave && !existing) {
      article.setAttribute(PROCESSED_ATTR, "true");
      injectButton(article, tweetId);
      dlog("inject download", tweetId);
    } else if (shouldHave && existing) {
      // Re-seat / fix view mode only (injectButton is a no-op create path).
      injectButton(article, tweetId);
    } else if (!shouldHave && existing) {
      existing.remove();
      article.removeAttribute(PROCESSED_ATTR);
      dlog("remove download (no own media)", tweetId);
    }
  }
}

processTweets();

let scanScheduled = false;
function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    processTweets();
  });
}

const observer = new MutationObserver(() => scheduleScan());
observer.observe(document.body, { childList: true, subtree: true });

const orphanCheck = setInterval(() => {
  if (chrome.runtime?.id) return;
  clearInterval(orphanCheck);
  observer.disconnect();
  document.querySelectorAll(".twitterdl-wrapper, .xsave-harvester").forEach((el) => el.remove());
  document
    .querySelectorAll(`[${PROCESSED_ATTR}]`)
    .forEach((el) => el.removeAttribute(PROCESSED_ATTR));
}, 1000);
