/**
 * Read-only Caixin 要闻 article-directory metadata.
 * Finance and economy section IDs were independently verified against the
 * public category pages on 2026-11-16. Not a full-text scraper.
 * The unofficial public endpoint can change or impose access restrictions.
 */
import { parseBjt } from './wscn.js';

const API = 'https://gateway.caixin.com/api/extapi/homeInterface.jsp';
const CATEGORY = Object.freeze({
  finance: { id: '100300177', label: '金融·要闻' },
  economy: { id: '100300184', label: '经济·要闻' },
});
const PAGE_SIZE = 25;
const DAY_MS = 86_400_000;

async function fetchDirectoryPage(section, offset, fetcher) {
  const subject = CATEGORY[section].id;
  const url = new URL(API);
  url.search = new URLSearchParams({
    subject, type: '0', count: String(PAGE_SIZE),
    picdim: '_266_177', start: String(offset),
  }).toString();
  const response = await fetcher(url.toString(), {
    method: 'GET', redirect: 'manual',
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Caixin directory HTTP ${response.status}`);
  const payload = await response.json();
  const items = payload?.datas ?? payload?.data?.datas;
  if (!Array.isArray(items)) throw new Error('Unexpected Caixin directory schema');
  return items;
}

function normalizeArticle(raw, section) {
  const time = String(raw.time ?? '');
  const url = String(raw.link ?? '').replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\/[a-z0-9.-]*caixin\.com\//i.test(url)) {
    throw new Error('Unexpected Caixin article URL');
  }
  const id = url.match(/\/(\d+)\.html(?:[?#]|$)/)?.[1] ?? url;
  return {
    id: String(id),
    datetime_bjt: time,
    title: String(raw.desc ?? '').trim(),
    summary: String(raw.summ ?? '').trim().slice(0, 700),
    url,
    section,
    section_label: CATEGORY[section].label,
  };
}

/**
 * Read every article for one category within [start, end) Beijing time.
 * If complete is false, follow next_offset with the SAME interval and section.
 * Only complete=true proves the source list was traversed past the start;
 * it cannot prove no publisher-side omissions or corrections.
 */
export async function getCaixinWindowIndex({
  section, start, end, nextOffset = 0, pagesPerCall = 3,
}, fetcher = fetch) {
  if (!Object.hasOwn(CATEGORY, section)) throw new Error('section must be finance or economy');
  const startMs = parseBjt(start);
  const endMs = parseBjt(end);
  if (startMs >= endMs) throw new Error('start must precede end');
  if (endMs > Date.now()) throw new Error('end must not be in the future');
  if (endMs - startMs > DAY_MS * 21) throw new Error('maximum interval is 21 days');
  if (!Number.isInteger(nextOffset) || nextOffset < 0 || nextOffset > 5000 || nextOffset % PAGE_SIZE !== 0) {
    throw new Error('next_offset must be 0, 25, 50, ... up to 5000');
  }
  if (!Number.isInteger(pagesPerCall) || pagesPerCall < 1 || pagesPerCall > 5) {
    throw new Error('pages_per_call must be 1..5');
  }
  const unique = new Map();
  let previousOldest = Infinity, inspected = 0, pages = 0, duplicateIds = 0;
  let crossedStart = false;
  for (; pages < pagesPerCall; pages++) {
    const offset = nextOffset + pages * PAGE_SIZE;
    const rawItems = await fetchDirectoryPage(section, offset, fetcher);
    if (rawItems.length === 0) {
      throw new Error('Empty page before crossing window start; completeness not established');
    }
    let prev = Infinity, oldest = Infinity;
    for (const raw of rawItems) {
      const item = normalizeArticle(raw, section);
      const ts = parseBjt(item.datetime_bjt);
      if (ts > prev) throw new Error('Articles out of order within page');
      prev = ts;
      oldest = Math.min(ts, oldest);
      if (ts >= startMs && ts < endMs) {
        if (unique.has(item.url)) duplicateIds++;
        else unique.set(item.url, item);
      }
    }
    if (parseBjt(String(rawItems[0].time)) > previousOldest) {
      throw new Error('Articles out of order between pages');
    }
    previousOldest = oldest;
    inspected += rawItems.length;
    if (oldest < startMs) { crossedStart = true; pages++; break; }
    if (rawItems.length < PAGE_SIZE) {
      throw new Error('Source list exhausted before crossing window start');
    }
  }
  return {
    source: 'caixin',
    section,
    section_label: CATEGORY[section].label,
    start, end, timezone: 'Asia/Shanghai', interval: '[start, end)',
    complete: crossedStart,
    next_offset: crossedStart ? null : nextOffset + pages * PAGE_SIZE,
    pages_read: pages,
    upstream_items_inspected: inspected,
    batch_count: unique.size,
    duplicate_urls_in_batch: duplicateIds,
    completion_note: crossedStart
      ? 'Source list traversed beyond start; publisher-side omissions not ruled out.'
      : 'PARTIAL: call again with next_offset; do not declare full coverage.',
    items: [...unique.values()],
  };
}
