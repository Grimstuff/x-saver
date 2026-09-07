const DEBUG = false;
const dlog = (...args) => DEBUG && console.log("[XFetch/bg]", ...args);

/** Only X/Twitter media CDNs (and data: GIFs we encoded). */
function isAllowedMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("data:image/gif;base64,")) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return host === "video.twimg.com" || host === "pbs.twimg.com";
}

function sanitizeFilename(name) {
  return String(name || "xsave")
    .replace(/\.\./g, "_")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 180) || "xsave";
}

const MAX_GIF_DURATION_SEC = 30;
const MEDIA_CACHE_MAX = 80;


// Token algorithm copied from twitter's embed.js.
function syndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI)
    .toString(6 ** 2)
    .replace(/(0+|\.)/g, "");
}

// Dedupe in-flight + resolved calls so repeat clicks don't re-hit syndication.
const mediaInfoCache = new Map();

/** Public web client bearer (same as x.com). */
const X_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const REST_ID_QUERY = "2Acdg-VztGlHX7MjX67Ysw";

const REST_ID_FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

function getCookie(name) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.get({ url: "https://x.com", name }, (c) => {
        resolve(c?.value || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function mediaItemsFromEntities(mediaList) {
  const items = [];
  if (!Array.isArray(mediaList)) return items;
  for (const media of mediaList) {
    if (media.type === "video" || media.type === "animated_gif") {
      const variants =
        media.video_info?.variants?.filter((v) => v.content_type === "video/mp4" && v.url) ?? [];
      if (!variants.length) continue;
      variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      items.push({
        type: media.type,
        url: variants[0].url,
        preview: media.media_url_https || "",
        label: media.type === "animated_gif" ? "GIF" : "Video",
      });
    } else if (media.type === "photo") {
      const baseUrl = media.media_url_https;
      if (!baseUrl) continue;
      const path = String(baseUrl).split("?")[0];
      const extMatch = path.match(/\.([a-z0-9]+)$/i);
      items.push({
        type: "photo",
        url: `${path}?name=orig`,
        ext: extMatch ? extMatch[1].toLowerCase() : "jpg",
        preview: `${path}?name=small`,
        label: "Image",
      });
    }
  }
  return items;
}

function unwrapGraphqlTweet(result) {
  if (!result || typeof result !== "object") return null;
  if (result.__typename === "TweetWithVisibilityResults" && result.tweet) {
    return unwrapGraphqlTweet(result.tweet);
  }
  if (result.__typename === "TweetTombstone") return null;
  if (result.legacy || result.rest_id) return result;
  if (result.tweet) return unwrapGraphqlTweet(result.tweet);
  return null;
}

function extractMediaFromGraphql(json) {
  const raw = json?.data?.tweetResult?.result;
  const tweet = unwrapGraphqlTweet(raw);
  if (!tweet) return [];
  // Own media only — never quoted_status / quoted_status_result.
  const media =
    tweet.legacy?.extended_entities?.media ||
    tweet.extended_entities?.media ||
    [];
  return mediaItemsFromEntities(media);
}

async function fetchMediaViaGraphql(tweetId) {
  const ct0 = await getCookie("ct0");
  if (!ct0) {
    dlog("graphql skip: no ct0 cookie (not logged in on x.com?)");
    return [];
  }

  const variables = {
    tweetId: String(tweetId),
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
  };
  const fieldToggles = {
    withArticleRichContentState: true,
    withArticlePlainText: false,
    withGrokAnalyze: false,
    withDisallowedReplyControls: false,
  };
  const endpoint =
    `https://x.com/i/api/graphql/${REST_ID_QUERY}/TweetResultByRestId` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(REST_ID_FEATURES))}` +
    `&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;

  dlog("graphql TweetResultByRestId", { tweetId });
  const res = await fetch(endpoint, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "*/*",
      Authorization: `Bearer ${X_BEARER}`,
      "Content-Type": "application/json",
      "x-csrf-token": ct0,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en",
    },
    referrer: `https://x.com/i/web/status/${tweetId}`,
  });
  dlog("graphql response", { tweetId, status: res.status, ok: res.ok });
  if (!res.ok) {
    dlog("graphql failed body", await res.text().catch(() => ""));
    return [];
  }
  const json = await res.json();
  const items = extractMediaFromGraphql(json);
  dlog("graphql media", { tweetId, count: items.length, items });
  return items;
}

function fetchMediaInfo(tweetId) {
  if (mediaInfoCache.has(tweetId)) {
    return mediaInfoCache.get(tweetId);
  }

  if (!/^\d{1,25}$/.test(String(tweetId || ""))) {
    return Promise.reject(new Error("Invalid tweet id"));
  }

  const promise = (async () => {
    try {
      const token = syndicationToken(tweetId);
      const url =
        `https://cdn.syndication.twimg.com/tweet-result` +
        `?id=${tweetId}&token=${token}&lang=en`;
      dlog("syndication request", { tweetId, token, url });
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      dlog("syndication response", { tweetId, status: res.status, ok: res.ok });
      if (res.ok) {
        const json = await res.json();
        dlog("mediaDetails", json?.mediaDetails);
        const items = extractAllMedia(json);
        if (items.length) return items;
      }
    } catch (err) {
      dlog("syndication failed, trying graphql", err);
    }
    return fetchMediaViaGraphql(tweetId);
  })();

  mediaInfoCache.set(tweetId, promise);
  promise.catch(() => mediaInfoCache.delete(tweetId));
  if (mediaInfoCache.size > MEDIA_CACHE_MAX) {
    const first = mediaInfoCache.keys().next().value;
    mediaInfoCache.delete(first);
  }
  return promise;
}

function extractAllMedia(json) {
  if (!json || typeof json !== "object") {
    throw new Error("Syndication response not JSON-shaped");
  }
  if (json.__typename === "TweetTombstone") {
    return [];
  }
  if (!json.mediaDetails) return [];
  if (!Array.isArray(json.mediaDetails)) {
    throw new Error("Unexpected mediaDetails shape in syndication response");
  }

  // Only THIS tweet's mediaDetails — never quoted_tweet.mediaDetails.
  const items = [];
  for (const media of json.mediaDetails) {
    if (media.type === "video" || media.type === "animated_gif") {
      const variants =
        media.video_info?.variants?.filter(
          (v) => v.content_type === "video/mp4"
        ) ?? [];
      if (variants.length === 0) continue;
      variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      items.push({
        type: media.type,
        url: variants[0].url,
        preview: media.media_url_https || "",
        label: media.type === "animated_gif" ? "GIF" : "Video",
      });
    } else if (media.type === "photo") {
      const baseUrl = media.media_url_https;
      if (!baseUrl) continue;
      const extMatch = baseUrl.match(/\.([a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
      items.push({
        type: "photo",
        url: `${baseUrl}?name=orig`,
        ext,
        preview: `${baseUrl}?name=small`,
        label: "Image",
      });
    }
  }

  dlog("extracted media (own tweet only)", items);
  return items;
}

const DEFAULT_SETTINGS = {
  gifEnabled: true,
  gifQuality: "medium",
  filenameTemplate: "{username}_{tweetid}",
};

const QUALITY_PRESETS = {
  low:    { maxWidth: 360, fps: 10 },
  medium: { maxWidth: 480, fps: 24 },
  high:   { maxWidth: 720, fps: 30 },
};

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, resolve);
  });
}

const OFFSCREEN_PATH = "src/offscreen.html";

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS"],
    justification: "Decode MP4 frames and encode an animated GIF.",
  });
}

/** Prefer username_tweetid; always keep tweet id when we have one. */
function gifDownloadStem(filename, tweetId) {
  let stem = sanitizeFilename(filename);
  const id = tweetId && /^\d{1,25}$/.test(String(tweetId)) ? String(tweetId) : "";
  if (!stem || stem === "download" || stem === "xsave") {
    stem = id ? `x_${id}` : `x_${Date.now()}`;
  } else if (id && !stem.includes(id)) {
    stem = sanitizeFilename(`${stem}_${id}`);
  }
  return stem;
}

async function convertToGif(mp4Url, filename, tabId, tweetId) {
  dlog("convertToGif start", { mp4Url, filename, tweetId });
  if (!isAllowedMediaUrl(mp4Url)) {
    throw new Error("Refusing to fetch non-Twitter media URL");
  }
  const safeName = gifDownloadStem(filename, tweetId);
  const settings = await getSettings();
  const quality = QUALITY_PRESETS[settings.gifQuality] ?? QUALITY_PRESETS.medium;

  await ensureOffscreenDocument();
  // Offscreen encodes + createObjectURL; SW owns chrome.downloads (offscreen lacks it).
  const response = await chrome.runtime.sendMessage({
    type: "CONVERT_TO_GIF",
    target: "offscreen",
    url: mp4Url,
    tabId,
    tweetId,
    maxWidth: quality.maxWidth,
    fps: quality.fps,
    maxDurationSec: MAX_GIF_DURATION_SEC,
  });
  dlog("convertToGif response", { ok: response?.ok, error: response?.error });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Conversion failed");
  }
  if (!response.objectUrl || !String(response.objectUrl).startsWith("blob:")) {
    throw new Error("Unexpected GIF payload from offscreen");
  }

  try {
    await chrome.downloads.download({
      url: response.objectUrl,
      filename: `${safeName}.gif`,
      saveAs: true,
      conflictAction: "uniquify",
    });
  } finally {
    setTimeout(() => {
      chrome.runtime
        .sendMessage({
          type: "REVOKE_GIF_URL",
          target: "offscreen",
          objectUrl: response.objectUrl,
        })
        .catch(() => {});
    }, 60_000);
  }
  dlog("convertToGif download dispatched", { filename: safeName });
}

function looksLikeXGif(srcUrl) {
  if (!srcUrl) return false;
  return (
    srcUrl.includes("video.twimg.com/tweet_video") ||
    srcUrl.includes("/tweet_video/") ||
    /tweet_video/i.test(srcUrl)
  );
}

function isUselessSrcUrl(srcUrl) {
  return !srcUrl || srcUrl.startsWith("blob:") || srcUrl === "about:blank";
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "xsave-image",
      title: "Save image (orig)",
      contexts: ["image"],
      documentUrlPatterns: ["https://twitter.com/*", "https://x.com/*"],
    });
    chrome.contextMenus.create({
      id: "xsave-video",
      title: "Save as GIF",
      contexts: ["video"],
      documentUrlPatterns: ["https://twitter.com/*", "https://x.com/*"],
    });
  });
}

chrome.runtime.onInstalled.addListener(createContextMenus);
chrome.runtime.onStartup.addListener(createContextMenus);

async function resolveMp4FromTab(tabId) {
  if (!tabId) throw new Error("No active tab to resolve media URL");
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "RESOLVE_VIDEO_MP4",
  });
  if (!response?.ok || !response.url) {
    throw new Error(response?.error ?? "Could not resolve MP4 URL from page");
  }
  return { url: response.url, tweetId: response.tweetId ?? null, forceGif: !!response.forceGif };
}

async function handleVideoSave(info, tab) {
  const tabId = tab?.id;
  let srcUrl = info.srcUrl;
  let tweetId = null;
  let forceGif = false;

  if (isUselessSrcUrl(srcUrl)) {
    dlog("blob/missing srcUrl — asking content script");
    const resolved = await resolveMp4FromTab(tabId);
    srcUrl = resolved.url;
    tweetId = resolved.tweetId;
    forceGif = resolved.forceGif;
  }

  const settings = await getSettings();
  const filename = tweetId
    ? sanitizeFilename(
        settings.filenameTemplate
          .replace(/{username}/g, "x")
          .replace(/{tweetid}/g, String(tweetId))
          .replace(/{date}/g, new Date().toISOString().slice(0, 10).replace(/-/g, ""))
          .replace(/{type}/g, "gif")
          .replace(/{index}/g, "")
      )
    : `x_${Date.now()}`;

  const asGif = forceGif || looksLikeXGif(srcUrl);
  if (asGif) {
    await convertToGif(srcUrl, filename, tabId, tweetId);
  } else {
    try {
      await convertToGif(srcUrl, filename, tabId, tweetId);
    } catch (err) {
      dlog("GIF convert failed, falling back to MP4", err);
      if (!isAllowedMediaUrl(srcUrl)) throw err;
      await chrome.downloads.download({
        url: srcUrl,
        filename: `${gifDownloadStem(filename, tweetId)}.mp4`,
        saveAs: true,
      });
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "xsave-image") {
    const srcUrl = info.srcUrl;
    if (!srcUrl || srcUrl.startsWith("blob:")) return;
    const base = srcUrl.split("?")[0];
    const extMatch = base.match(/\.([a-z0-9]+)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
    const orig = `${base}?name=orig`;
    if (!isAllowedMediaUrl(orig)) return;
    chrome.downloads.download({
      url: orig,
      filename: `${sanitizeFilename("xsave_" + Date.now())}.${ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" ? ext : "jpg"}`,
      saveAs: true,
    });
    return;
  }

  if (info.menuItemId === "xsave-video") {
    handleVideoSave(info, tab).catch((err) =>
      dlog("context menu Save as GIF error", err)
    );
  }
});

function isTrustedSender(sender) {
  // Offscreen / extension pages
  if (sender.id === chrome.runtime.id && !sender.tab) return true;
  const url = sender.tab?.url || sender.url || "";
  try {
    const u = new URL(url);
    return u.hostname === "x.com" || u.hostname === "twitter.com" || u.hostname.endsWith(".x.com") || u.hostname.endsWith(".twitter.com") || url.startsWith(chrome.runtime.getURL(""));
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  dlog("message received", message?.type);

  // Progress relay: offscreen → background → content script (extension-internal)
  if (message.type === "GIF_PROGRESS" && message.tabId) {
    if (sender.id !== chrome.runtime.id) return;
    chrome.tabs.sendMessage(message.tabId, {
      type: "GIF_PROGRESS",
      tweetId: message.tweetId,
      progress: message.progress,
    }).catch(() => {});
    return;
  }

  // Offscreen-owned messages — ignore in the service worker listener
  if (message.type === "CONVERT_TO_GIF" || message.type === "REVOKE_GIF_URL") return;

  if (!isTrustedSender(sender)) {
    dlog("rejected untrusted sender", sender);
    return;
  }

  if (message.type === "FETCH_MEDIA_URL") {
    fetchMediaInfo(message.tweetId)
      .then((items) => sendResponse({ items: items ?? [] }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "DOWNLOAD_FILE") {
    const ext = String(message.ext || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
    if (!isAllowedMediaUrl(message.url)) {
      sendResponse({ error: "Blocked non-Twitter URL" });
      return true;
    }
    chrome.downloads
      .download({
        url: message.url,
        filename: `${sanitizeFilename(message.filename)}.${ext}`,
        saveAs: false,
      })
      .then((id) => sendResponse({ id }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "DOWNLOAD_AS_GIF") {
    const tabId = sender.tab?.id;
    if (!isAllowedMediaUrl(message.url)) {
      sendResponse({ ok: false, error: "Blocked non-Twitter URL" });
      return true;
    }
    getSettings().then((settings) => {
      if (!settings.gifEnabled) {
        chrome.downloads.download({
          url: message.url,
          filename: `${sanitizeFilename(message.filename)}.mp4`,
          saveAs: true,
        });
        sendResponse({ ok: true });
        return;
      }
      convertToGif(message.url, message.filename, tabId, message.tweetId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    });
    return true;
  }
});
