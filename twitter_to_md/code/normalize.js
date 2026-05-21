// Normalize X API v2 response objects into our stable on-disk schema.
//
// X API v2 returns:
//   data: [ { id, text, created_at, author_id, referenced_tweets: [{type, id}], ... } ]
//   includes: { users:[], tweets:[], media:[] }
//
// `referenced_tweets[].type` ∈ "replied_to" | "quoted" | "retweeted".
// We resolve each via the `includes.tweets` array.

function buildIncludeMaps(includes = {}) {
  const users = new Map();
  for (const u of includes.users || []) users.set(u.id, u);
  const tweets = new Map();
  for (const t of includes.tweets || []) tweets.set(t.id, t);
  const media = new Map();
  for (const m of includes.media || []) media.set(m.media_key, m);
  return { users, tweets, media };
}

function shapeAuthor(authorId, usersMap) {
  if (!authorId) return null;
  const u = usersMap.get(authorId);
  return {
    id: authorId,
    username: u?.username || null,
    name: u?.name || null,
  };
}

function shapeMedia(mediaKeys, mediaMap) {
  if (!Array.isArray(mediaKeys)) return [];
  return mediaKeys.map((k) => {
    const m = mediaMap.get(k);
    if (!m) return null;
    return {
      type: m.type || null,                   // photo | video | animated_gif
      url: m.url || m.preview_image_url || null,
      preview_url: m.preview_image_url || null,
    };
  }).filter(Boolean);
}

// `seen` prevents infinite recursion if includes.tweets contains a cycle
// (shouldn't happen, but cheap guard).
function normalizeOne(raw, maps, seen = new Set()) {
  if (!raw || seen.has(raw.id)) return null;
  seen.add(raw.id);

  const refs = raw.referenced_tweets || [];
  const repliedTo = refs.find((r) => r.type === 'replied_to');
  const quoted = refs.find((r) => r.type === 'quoted');
  const retweeted = refs.find((r) => r.type === 'retweeted');

  const author = shapeAuthor(raw.author_id, maps.users);
  const tweetUrl = author?.username
    ? `https://x.com/${author.username}/status/${raw.id}`
    : `https://x.com/i/status/${raw.id}`;

  return {
    id: raw.id || null,
    url: tweetUrl,
    created_at: raw.created_at || null,
    text: raw.text || '',
    lang: raw.lang || null,
    author,
    is_reply: !!repliedTo,
    is_quote: !!quoted,
    is_retweet: !!retweeted,
    conversation_id: raw.conversation_id || null,
    in_reply_to: repliedTo ? {
      tweet_id: repliedTo.id,
      user_id: raw.in_reply_to_user_id || null,
      url: `https://x.com/i/status/${repliedTo.id}`,
    } : null,
    quoted_tweet: quoted ? normalizeOne(maps.tweets.get(quoted.id), maps, seen) : null,
    retweeted_tweet: retweeted ? normalizeOne(maps.tweets.get(retweeted.id), maps, seen) : null,
    media: shapeMedia(raw.attachments?.media_keys, maps.media),
    metrics: {
      likes: raw.public_metrics?.like_count ?? null,
      retweets: raw.public_metrics?.retweet_count ?? null,
      replies: raw.public_metrics?.reply_count ?? null,
      quotes: raw.public_metrics?.quote_count ?? null,
      views: raw.public_metrics?.impression_count ?? null,
    },
    // Filled later by resolve-threads.js. Ordered root → ... → direct parent.
    thread_context: [],
  };
}

// Public entry: normalize an X API response `{ data, includes }`.
// Returns array of normalized tweets.
export function normalizeResponse({ data, includes } = {}) {
  const maps = buildIncludeMaps(includes);
  return (data || []).map((raw) => normalizeOne(raw, maps)).filter(Boolean);
}

// Normalize a single raw tweet given pre-built include maps. Used by
// resolve-threads.js when stitching fetched parents into the lookup map.
export function normalizeSingle(raw, includes = {}) {
  const maps = buildIncludeMaps(includes);
  return normalizeOne(raw, maps);
}
