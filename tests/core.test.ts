import { describe, it, expect } from 'vitest';
import { AppError, BASE_SCOPES, docSchema, profileSchema, requireScopes, safeError, settings, withLock } from '../src/core.js';
import { contentSchema, Cursors, toBlocks } from '../src/services.js';
import { setup } from './helpers.js';

describe('input and policy boundaries', () => {
  it('accepts direct Docx links but rejects hostile URLs, wiki, paths and ports', () => {
    expect(docSchema.parse('https://example.feishu.cn/docx/abc_123?from=share')).toBe('abc_123');
    expect(docSchema.parse('abc_123')).toBe('abc_123');
    for (const input of ['https://feishu.cn.evil.com/docx/id', 'https://evil.com/docx/id', 'http://a.feishu.cn/docx/id',
      'https://a.feishu.cn:123/docx/id', 'https://user@a.feishu.cn/docx/id', 'https://a.feishu.cn/wiki/id', '../secrets', '//evil']) {
      expect(docSchema.safeParse(input).success, input).toBe(false);
    }
    expect(profileSchema.safeParse('../default').success).toBe(false);
  });
  it('does not include sending/search-docs and defaults writes off', () => {
    expect(BASE_SCOPES).not.toContain('search:docs:read');
    expect(BASE_SCOPES).not.toContain('im:message.send_as_user');
    expect(settings({}).writes).toBe(false);
    expect(settings({ BETTER_FEISHU_MCP_ENABLE_WRITES: 'true' }).writes).toBe(false);
    expect(settings({ BETTER_FEISHU_MCP_ENABLE_WRITES: '1' }).writes).toBe(true);
  });
  it('requires AND groups while permitting exact OR alternatives', () => {
    expect(() => requireScopes(['read'], [['read', 'all'], 'group'])).toThrow(AppError);
    expect(() => requireScopes(['all', 'group'], [['read', 'all'], 'group'])).not.toThrow();
  });
  it('never reveals unknown error messages', () => {
    expect(JSON.stringify(safeError(new Error('private token goes here')))).not.toContain('private token');
  });
  it('serializes cross-instance locks and cleans up lock directories', async () => {
    const { config, cleanup } = await setup(); const order: string[] = [];
    try {
      await Promise.all([withLock(config, 'same', async () => { order.push('a'); await new Promise(r => setTimeout(r, 50)); order.push('b'); }),
        withLock(config, 'same', async () => { order.push('c'); })]);
      expect([['a', 'b', 'c'], ['c', 'a', 'b']]).toContainEqual(order);
      await withLock(config, 'same', async () => {});
    } finally { await cleanup(); }
  });
});
describe('bounded output helpers', () => {
  it('caps document content at the Feishu limit of 50 blocks', () => {
    const blocks = Array.from({ length: 50 }, () => ({ type: 'paragraph' as const, text: 'x' }));
    expect(contentSchema.parse(blocks)).toHaveLength(50);
    expect(contentSchema.safeParse([...blocks, blocks[0]]).success).toBe(false);
  });
  it('binds opaque cursors to the query and instance', () => {
    const cursors = new Cursors(); const id = cursors.put(['query', 1], 'provider-page')!;
    expect(cursors.get(['query', 1], id)).toBe('provider-page');
    expect(() => cursors.get(['query', 2], id)).toThrow();
    expect(() => new Cursors().get(['query', 1], id)).toThrow();
  });
  it('maps explicitly supported content to block types', () => {
    expect(toBlocks([{ type: 'heading', level: 2, text: 'Title' }])).toEqual([
      { block_type: 4, heading2: { elements: [{ text_run: { content: 'Title' } }] } },
    ]);
    expect(toBlocks([{ type: 'paragraph', text: 'hi' }])[0]?.block_type).toBe(2);
  });
});
