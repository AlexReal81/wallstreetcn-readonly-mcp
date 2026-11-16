/**
 * WallStreetCN 7x24 feed adapter (read only).
 * Public but undocumented endpoint; subject to change or access controls.
 * The only upstream host is hard-coded. No arbitrary URL fetching is possible.
 */
const UPSTREAM = 'https://api-one.wallstcn.com/apiv1/content/lives';
const PAGE_LIMIT = 50;
const BJT_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;

export function parseBjt(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new Error('Use Beijing time: YYYY-MM-DD HH:mm:ss');
  }
  const timestamp = Date.parse(value.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(timestamp) || formatBjt(timestamp) !== value) {
    throw new Error('Invalid Beijing datetime: ' + value);
  }
  return timestamp;
}

export function formatBjt(utcMs) {
  return new Date(utcMs + BJT_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

export function htmlToText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>\s*<p\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => fromCodepoint(Number(d)))
    .replace(/&#x([\da-f]+);/gi, (_, h) => fromCodepoint(parseInt(h, 16)))
    .trim();
}

function fromCodepoint(code) {
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function ensureTimestamp(raw) {
  const ts = Number(raw.display_time);
  if (!Number.isSafeInteger(ts) || ts <= 0) throw new Error('Invalid display_time');
  return ts * 1000;
}

export function normalizeIndex(raw) {
  const id = String(raw.id ?? '');
  if (!/^\d+$/.test(id)) throw new Error('Missing/invalid live news ID');
  const ms = ensureTimestamp(raw);
  const excerpt = String(raw.content_text || '').trim() || htmlToText(raw.content);
  return {
    id,
    datetime_bjt: formatBjt(ms),
    score: Number(raw.score || 1),
    title: String(raw.title || '').trim(),
    preview: excerpt.slice(0, 160),
    url: `https://wallstreetcn.com/livenews/${id}`,
  };
}

export function normalizeDetail(raw) {
  const brief = normalizeIndex(raw);
  const content = String(raw.content || '');
  const contentMore = String(raw.content_more || '');
  const fullText = htmlToText(content + (contentMore ? '\n' + contentMore : '')) ||
    String(raw.content_text || '').trim();
  return {
    ...brief,
    content: fullText,
    article: raw.article ? {
      id: raw.article.id ?? null,
      title: String(raw.article.title || ''),
      url: String(raw.article.uri || ''),
    } : null,
    images: (Array.isArray(raw.images) ? raw.images : [])
      .map(x => String(x?.uri || '')).filter(Boolean).slice(0, 12),
    calendar: raw.is_calendar ? {
      wscn_ticker: String(raw.wscn_ticker || ''),
      calendar_key: String(raw.calendar_key || ''),
    } : null,
  };
}

async function fetchPayload(url, fetcher = fetch) {
  const response = await fetcher(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !payload.data) throw new Error('Unexpected upstream JSON schema');
  return payload.data;
}

async function fetchPage(cursor, fetcher = fetch) {
  const params = new URLSearchParams({
    channel: 'global-channel', client: 'pc', limit: String(PAGE_LIMIT),
  });
  if (cursor == null) params.set('first_page', 'true');
  else params.set('cursor', String(cursor));
  const data = await fetchPayload(`${UPSTREAM}?${params}`, fetcher);
  if (!Array.isArray(data.items)) throw new Error('Unexpected upstream items schema');
  return { items: data.items, nextCursor: data.next_cursor == null ? null : String(data.next_cursor) };
}

export async function probeFeed(fetcher = fetch) {
  const data = await fetchPage(null, fetcher);
  return {
    source: 'wallstreetcn 7x24 global-channel',
    reachable: true,
    received: data.items.length,
    has_next_cursor: Boolean(data.nextCursor),
    latest: data.items.slice(0, 3).map(normalizeIndex),
    collected_at_bjt: formatBjt(Date.now()),
    ...(fetcher === fetch ? {reuters_rss_probe: await probeReutersRss()} : {}),
  };
}

/**
 * Deliberately bounded per call. Call again with next_cursor until complete.
 * complete means the traversed feed crossed the window start, not that the
 * publisher's historical feed is guaranteed globally exhaustive.
 */
export async function getWindowIndex({ start, end, cursor, pagesPerCall = 6 }, fetcher = fetch) {
  const startMs = parseBjt(start), endMs = parseBjt(end);
  if (startMs >= endMs) throw new Error('Start must precede end');
  if (endMs > Date.now()) throw new Error('Window end must already have passed');
  if (endMs - startMs > 7 * DAY_MS) throw new Error('Maximum time window is 7 days');
  if (!Number.isInteger(pagesPerCall) || pagesPerCall < 1 || pagesPerCall > 8) {
    throw new Error('pagesPerCall must be 1..8');
  }
  if (cursor != null && (typeof cursor !== 'string' || !cursor || cursor.length > 256)) {
    throw new Error('Invalid cursor');
  }
  const seenCursors = new Set();
  const unique = new Map();
  let nextCursor = cursor || null;
  let previousPageOldest = Infinity;
  let inspected = 0, pagesRead = 0, duplicates = 0, crossedStart = false;
  while (pagesRead < pagesPerCall) {
    const key = nextCursor === null ? '__FIRST__' : nextCursor;
    if (seenCursors.has(key)) throw new Error('Cursor loop');
    seenCursors.add(key);
    const page = await fetchPage(nextCursor, fetcher);
    pagesRead += 1;
    if (!page.items.length) throw new Error('Empty page before crossing window start');
    let prevTs = Infinity, oldestTs = Infinity;
    for (const raw of page.items) {
      const ts = ensureTimestamp(raw);
      if (ts > prevTs) throw new Error('Unsorted page; completeness not established');
      prevTs = ts;
      oldestTs = Math.min(oldestTs, ts);
      if (ts >= startMs && ts < endMs) {
        const item = normalizeIndex(raw);
        if (unique.has(item.id)) duplicates++;
        else unique.set(item.id, item);
      }
    }
    const newestTs = ensureTimestamp(page.items[0]);
    if (newestTs > previousPageOldest) throw new Error('Page ordering violation');
    previousPageOldest = oldestTs;
    inspected += page.items.length;
    if (oldestTs < startMs) { crossedStart = true; nextCursor = null; break; }
    if (!page.nextCursor) throw new Error('No cursor before reaching window start');
    if (seenCursors.has(page.nextCursor)) throw new Error('Cursor loop');
    nextCursor = page.nextCursor;
  }
  return {
    source: 'wallstreetcn', channel: 'global-channel',
    timezone: 'Asia/Shanghai', interval: '[start, end)',
    start, end,
    complete: crossedStart,
    completion_note: crossedStart
      ? 'API cursor traversal crossed window start; does not prove the publisher never omitted/edited items.'
      : 'PARTIAL BATCH: call again with the SAME start/end and next_cursor. Do not claim full coverage yet.',
    next_cursor: crossedStart ? null : nextCursor,
    pages_read: pagesRead, upstream_items_inspected: inspected,
    batch_count: unique.size, duplicate_ids_in_batch: duplicates,
    items: [...unique.values()],
  };
}

/**
 * Full-text lookup through the same list endpoint as the working index tool.
 * Provide the index timestamp to avoid scanning unrelated historical pages.
 */
export async function getNewsById(id, fetcher = fetch, { datetimeBjt } = {}) {
  const targetId = String(id);
  if (!/^\d{1,20}$/.test(targetId)) throw new Error('ID must be digits');
  const targetMs = datetimeBjt == null ? null : parseBjt(datetimeBjt);
  if (targetMs != null && targetMs > Date.now()) throw new Error('datetime_bjt must not be in the future');

  // A one-hour head start enables fast lookups of older published items.
  let cursor = targetMs == null ? null : String(Math.floor(targetMs / 1000) + 3600);
  const maxPages = targetMs == null ? 16 : 8;
  const seenCursors = new Set();

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const key = cursor == null ? '__FIRST__' : cursor;
    if (seenCursors.has(key)) throw new Error('Cursor loop while locating news ID');
    seenCursors.add(key);

    const page = await fetchPage(cursor, fetcher);
    if (!page.items.length) break;

    let previousTs = Infinity;
    for (const raw of page.items) {
      const ts = ensureTimestamp(raw);
      if (ts > previousTs) throw new Error('Unsorted feed page while locating news ID');
      previousTs = ts;
      if (String(raw.id ?? '') !== targetId) continue;

      const detail = normalizeDetail(raw);
      const { content, ...metadata } = detail;
      return {
        ...metadata,
        body_text: content,
        retrieval_source: 'verified_live_feed_list',
        expanded_part_present: Boolean(raw.content_more),
        pages_read: pageNo,
      };
    }

    const oldestMs = ensureTimestamp(page.items[page.items.length - 1]);
    if (targetMs != null && oldestMs < targetMs - 60_000) break;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  if (targetMs == null) {
    throw new Error('News ID not found in the latest 16 pages. Supply datetime_bjt from get_news_window_index for older news.');
  }
  throw new Error('News ID not found near the supplied datetime_bjt; it may have been edited or removed from the feed.');
}


/**
 * TEMPORARY RSS metadata connectivity test. Do not copy or cache article text.
 * Google News feed is a third-party search result, NOT a Reuters official feed.
 */
async function probeReutersRss() {
  const searches = [
    {name: 'reuters_all', q: 'when:24h site:reuters.com'},
    {name: 'reuters_world', q: 'when:24h site:reuters.com/world/'},
    {name: 'reuters_markets', q: 'when:24h site:reuters.com/markets/'},
    {name: 'reuters_business', q: 'when:24h site:reuters.com/business/'},
  ];
  const decode = (v) => String(v || '')
    .replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const pick = (item,tag) => {
    const m = item.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
    return m ? decode(m[1]) : '';
  };
  return Promise.all(searches.map(async ({name,q}) => {
    const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q)
       + '&hl=en-US&gl=US&ceid=US%3Aen';
    try {
      const resp = await fetch(url, {
        redirect: 'manual', method: 'GET',
        headers: {Accept:'application/rss+xml,application/xml;q=0.9,*/*;q=0.5',
          'User-Agent':'Mozilla/5.0'},
        signal: AbortSignal.timeout(10000),
      });
      const body = await resp.text();
      const data = {
        name, status:resp.status, content_type:resp.headers.get('content-type') || '',
        response_chars:body.length, rss_valid: /<(rss|feed)\b/i.test(body.slice(0,3000)),
      };
      if (resp.status !== 200 || !data.rss_valid) {
        data.error_hint = body.slice(0,120).replace(/\s+/g,' ');
        return data;
      }
      const items = [...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(x=>x[1]);
      data.item_count = items.length;
      const dates = items.map(i => Date.parse(pick(i,'pubDate'))).filter(Number.isFinite);
      data.newest_iso = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
      data.oldest_iso = dates.length ? new Date(Math.min(...dates)).toISOString() : null;
      data.items_missing_pubdate = items.length - dates.length;
      const sources = {};
      for (const it of items) {
        const source = pick(it,'source') || '(none)';
        sources[source] = (sources[source] || 0) + 1;
      }
      data.source_counts = Object.entries(sources).sort((a,b) => b[1]-a[1]).slice(0,7);
      data.first_three = items.slice(0,3).map(it => ({
        title:pick(it,'title').slice(0,150),
        pubdate:pick(it,'pubDate').slice(0,80),
        source:pick(it,'source').slice(0,100),
        link:pick(it,'link').slice(0,210),
        guid:pick(it,'guid').slice(0,120),
      }));
      return data;
    } catch (e) {
      return {name,error:String(e?.message||e).slice(0,220)};
    }
  }));
}
