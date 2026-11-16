import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBjt, formatBjt, htmlToText, getWindowIndex, getNewsById, probeFeed } from '../src/wscn.js';

const epoch = s => Math.floor(parseBjt(s) / 1000);
const item = (id, when, extra = {}) => ({ id, display_time: epoch(when), score: 1,
  title: '', content_text: `Item ${id}`, ...extra });
const fakeFeed = (pages) => async (url) => {
  const u = new URL(url);
  let data;
  if (u.pathname.endsWith('/32001')) {
    data = { id: 32001, display_time: epoch('2026-11-15 18:01:00'), score: 3,
      title: '', content: '<p>测试&amp;消息</p>', content_more: '<p>展开内容</p>' };
  } else {
    const key = u.searchParams.get('cursor') || '__FIRST__';
    if (!(key in pages)) return { ok: true, json: async () => ({ data: { items: [], next_cursor: null } }) };
    data = pages[key];
  }
  return { ok: true, status: 200, json: async () => ({ data }) };
};

test('BJT format and boundary validation', () => {
  assert.equal(formatBjt(parseBjt('2026-11-15 19:00:00')), '2026-11-15 19:00:00');
  assert.throws(() => parseBjt('2026-02-30 19:00:00'));
  assert.equal(htmlToText('<p>A&amp;B<br>换行</p>'), 'A&B\n换行');
});

test('window is left-closed and right-open; batches have accurate completeness', async () => {
  const pages = {
    __FIRST__: { items: [item(4, '2026-11-15 19:00:00'), item(3, '2026-11-15 18:59:59')], next_cursor: 'c2' },
    c2: { items: [item(2, '2026-11-15 18:00:00'), item(1, '2026-11-14 18:59:59')], next_cursor: 'c3' },
  };
  const f = fakeFeed(pages);
  const common = { start: '2026-11-14 19:00:00', end: '2026-11-15 19:00:00' };
  const batch1 = await getWindowIndex({ ...common, pagesPerCall: 1 }, f);
  assert.equal(batch1.complete, false);
  assert.equal(batch1.batch_count, 1);
  assert.equal(batch1.items[0].id, '3');
  assert.equal(batch1.next_cursor, 'c2');
  const batch2 = await getWindowIndex({ ...common, pagesPerCall: 1, cursor: batch1.next_cursor }, f);
  assert.equal(batch2.complete, true);
  assert.equal(batch2.batch_count, 1);
  assert.equal(batch2.items[0].id, '2');
  assert.equal(batch2.next_cursor, null);
});

test('no silent success when cursor ends early', async () => {
  const f = fakeFeed({ __FIRST__: { items: [item(9, '2026-11-15 18:59:59')], next_cursor: null } });
  await assert.rejects(() => getWindowIndex({ start: '2026-11-14 19:00:00', end: '2026-11-15 19:00:00' }, f), /No cursor/);
});

test('news by ID joins expanded HTML; probe reports valid data', async () => {
  const f = fakeFeed({ __FIRST__: { items: [item(32001, '2026-11-15 18:01:00')], next_cursor: 'after' } });
  const p = await probeFeed(f);
  assert.equal(p.received, 1);
  const d = await getNewsById('32001', f);
  assert.match(d.content, /测试&消息/);
  assert.match(d.content, /展开内容/);
});
