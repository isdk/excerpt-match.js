import { describe, expect, it } from 'vitest';
import { splitSegments } from './splitSegments';

describe('splitSegments', () => {
  it('按句子结束符切段', () => {
    const segs = splitSegments('第一句。第二句。');
    expect(segs.length).toBe(2);
    expect(segs[0].text).toBe('第一句。');
    expect(segs[1].text).toBe('第二句。');
  });

  it('★ start 可用于回切原文', () => {
    const text = '第一句。第二句。第三句。';
    for (const seg of splitSegments(text)) {
      expect(text.slice(seg.start, seg.start + seg.text.length)).toBe(seg.text);
    }
  });

  it('按空行切段', () => {
    const segs = splitSegments('第一段\n\n第二段');
    expect(segs.length).toBe(2);
  });

  it('超长段落继续切', () => {
    const long = 'a'.repeat(250);
    const segs = splitSegments(long, 100);
    expect(segs.length).toBe(3);
    expect(segs.every((s) => s.text.length <= 100)).toBe(true);
  });

  it('空文本 → 空数组', () => {
    expect(splitSegments('')).toEqual([]);
  });

  it('无边界符时兜底成整段', () => {
    const segs = splitSegments('没有标点的连续文本');
    expect(segs.length).toBeGreaterThanOrEqual(1);
    expect(segs[0].text).toContain('没有标点');
  });
});
