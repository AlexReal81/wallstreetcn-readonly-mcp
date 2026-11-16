/**
 * WallStreetCN read-only MCP for Cloudflare Workers.
 * Stateless Streamable HTTP: https://<your-worker>.workers.dev/mcp
 * Uses Cloudflare Agents' official handler (not a hand-written MCP transport).
 */
import { createMcpHandler } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { probeFeed, getWindowIndex, getNewsById } from './wscn.js';

function wrap(handler) {
  return async (args) => {
    try {
      const payload = await handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: 'WSCN_ERROR: ' + (error?.message || String(error)) }] };
    }
  };
}

function createServer() {
  const server = new McpServer({ name: 'WallStreetCN Readonly News', version: '0.1.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

  server.registerTool('probe_news_source', {
    description: 'Read-only connection test. Returns the three latest items from WallStreetCN 7x24 要闻 live feed, newest timestamps, and cursor availability.',
    inputSchema: {}, annotations,
  }, wrap(async () => probeFeed()));

  server.registerTool('get_news_window_index', {
    description: 'Read-only, NO KEYWORD FILTER. Get all WallStreetCN 7x24 要闻 headlines/previews in a specified Beijing-time interval [start,end). Fetches at most 8 upstream pages per call; if complete=false, call again with identical start/end and next_cursor until complete=true. Do not confuse a partial batch with a full daily scan. Every returned item includes ID, Beijing timestamp, score, title, and preview. Do not fabricate missing news.',
    inputSchema: {
      start: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).describe('Beijing time inclusive, e.g. 2026-11-15 19:00:00'),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).describe('Beijing time exclusive, e.g. 2026-11-16 19:00:00. Must be in the past.'),
      next_cursor: z.string().min(1).max(256).optional().describe('Pass back next_cursor from previous partial batch; omit on first call.'),
      pages_per_call: z.number().int().min(1).max(8).optional().describe('Upstream pages per call, 1..8, default 6. Each page usually holds 50 raw items.'),
    }, annotations,
  }, wrap(async ({ start, end, next_cursor, pages_per_call }) =>
    getWindowIndex({ start, end, cursor: next_cursor, pagesPerCall: pages_per_call ?? 6 })));

  server.registerTool('get_news_by_id', {
    description: 'Read-only. Fetch a WallStreetCN 7x24 news record by its verified numeric ID, including expanded (content_more) text and article/media references. Use only for selected items after reviewing a window index.',
    inputSchema: {
      id: z.string().regex(/^\d{1,20}$/).describe('Verified live-news ID returned by get_news_window_index'),
    }, annotations,
  }, wrap(async ({ id }) => getNewsById(id)));

  return server;
}

const handler = createMcpHandler(createServer, { route: '/mcp', responseMode: 'auto' });

export default {
  fetch(request, env, ctx) {
    const u = new URL(request.url);
    if (u.pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', name: 'WallStreetCN Readonly News MCP', endpoint: '/mcp' });
    }
    return handler(request, env, ctx);
  },
};
