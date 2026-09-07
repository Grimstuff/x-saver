(() => {
  if (window.__xsaveHookInstalled) return;
  window.__xsaveHookInstalled = true;
  const SOURCE = "xsave-media-hook";
  const post = (payload) => {
    try { window.postMessage({ source: SOURCE, ...payload }, location.origin); } catch (_) {}
  };

  const TWEET_PATH =
    /^(?:\/i\/api)?\/graphql\/[^/]+\/(TweetDetail|TweetResultByRestId|UserTweets|UserMedia|HomeTimeline|HomeLatestTimeline|UserTweetsAndReplies|UserHighlightsTweets|UserArticlesTweets|Bookmarks|Likes|ListLatestTweetsTimeline|SearchTimeline|CommunitiesExploreTimeline)$/;

  function walk(value, visit, depth, seen) {
    if (value == null || depth > 12 || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    visit(value);
    if (Array.isArray(value)) {
      for (const v of value) walk(v, visit, depth + 1, seen);
      return;
    }
    for (const k of Object.keys(value)) {
      try { walk(value[k], visit, depth + 1, seen); } catch (_) {}
    }
  }

  function itemFromMedia(media) {
    if (!media || typeof media !== "object") return null;
    const type = media.type || media.media_type || "";
    const preview = media.media_url_https || media.media_url || "";
    if (type === "video" || type === "animated_gif") {
      const variants = (media.video_info && media.video_info.variants) || [];
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
        url: base + "?name=orig",
        ext: extMatch ? extMatch[1].toLowerCase() : "jpg",
        preview,
        label: "Image",
      };
    }
    return null;
  }

  function mediaListsFrom(obj) {
    const lists = [];
    if (Array.isArray(obj.mediaDetails)) lists.push(obj.mediaDetails);
    if (obj.extended_entities && Array.isArray(obj.extended_entities.media)) {
      lists.push(obj.extended_entities.media);
    }
    if (obj.legacy && obj.legacy.extended_entities && Array.isArray(obj.legacy.extended_entities.media)) {
      lists.push(obj.legacy.extended_entities.media);
    }
    if (obj.entities && Array.isArray(obj.entities.media)) lists.push(obj.entities.media);
    if (obj.legacy && obj.legacy.entities && Array.isArray(obj.legacy.entities.media)) {
      lists.push(obj.legacy.entities.media);
    }
    return lists;
  }

  function tweetIdFrom(obj) {
    return (
      obj.rest_id ||
      obj.id_str ||
      (obj.legacy && obj.legacy.id_str) ||
      (obj.tweet && (obj.tweet.rest_id || (obj.tweet.legacy && obj.tweet.legacy.id_str))) ||
      null
    );
  }

  function harvest(json) {
    const byId = new Map();
    walk(json, (obj) => {
      const lists = mediaListsFrom(obj);
      if (!lists.length) return;
      const tweetId = tweetIdFrom(obj);
      if (!tweetId) return;
      const id = String(tweetId);
      if (!byId.has(id)) byId.set(id, []);
      const bucket = byId.get(id);
      const seen = new Set(bucket.map((i) => i.url));
      for (const list of lists) {
        for (const media of list) {
          const item = itemFromMedia(media);
          if (item && item.url && !seen.has(item.url)) {
            seen.add(item.url);
            bucket.push(item);
          }
        }
      }
    }, 0, new Set());
    for (const [tweetId, items] of byId) {
      if (items.length) post({ type: "MEDIA", tweetId, items });
    }
  }

  function sniff(text) {
    if (!text || text.length < 40) return;
    if (!/media_url_https|extended_entities|video_info|tweet_video/.test(text)) return;
    try { harvest(JSON.parse(text)); } catch (_) {}
  }

  function pathLooksTweetRelated(urlLike) {
    try {
      const u = typeof urlLike === "string" ? new URL(urlLike, location.origin) : urlLike;
      return TWEET_PATH.test(u.pathname);
    } catch (_) {
      return /graphql\/.+(TweetDetail|TweetResultByRestId|UserTweets|UserMedia|HomeTimeline)/.test(String(urlLike || ""));
    }
  }

  // X serves timeline/TweetDetail over XHR — this is what Media Harvest hooks.
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (pathLooksTweetRelated(url)) {
        this.addEventListener("load", function () {
          if (this.status === 200 && typeof this.responseText === "string") {
            sniff(this.responseText);
          }
        });
      }
    } catch (_) {}
    return xhrOpen.apply(this, arguments);
  };

  // Keep fetch too (some clients / future paths).
  const origFetch = window.fetch;
  window.fetch = async function () {
    const res = await origFetch.apply(this, arguments);
    try {
      const input = arguments[0];
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (pathLooksTweetRelated(url) || /api\.x\.com|api\.twitter\.com/i.test(url)) {
        res.clone().text().then(sniff).catch(() => {});
      }
    } catch (_) {}
    return res;
  };
})();