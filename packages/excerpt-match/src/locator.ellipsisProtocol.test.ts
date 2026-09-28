import { describe, expect, it } from 'vitest';
import { locateExcerpt } from './index';

/**
 * 「固定的省略约定」（`DEFAULT_ELLIPSIS`）的协议安全边界。
 *
 * ## 探针原理
 *
 * 文档是两段文字**直接相邻**：`第一段内容第二段内容`。
 * 摘录在这两段之间插入一个待测记号 P：`第一段内容${P}第二段内容`。
 *
 * - 若 P 被当作省略约定 → 摘录按它切段，两段锚点按序链式拼上 → `segmented`；
 * - 若 P 只是普通内容 → 带着 P 的字面在文档里找不到 → `none`
 *   （纯空白例外：CJK 间空白被归一化收拢后走 T1 → `normalized`，同样不是分段）。
 *
 * 所以断言统一为 `not.toBe('segmented')` —— 要验证的性质只有一个：
 * **常见正文标点永远不能触发切分**。谁往 `DEFAULT_ELLIPSIS` 里加了与正文
 * 同形的写法（`……`、`...`、`——`…），这里就会红 —— 约定与正文可区分
 * 是协议成立的底线，见 `types.ts` 里 `DEFAULT_ELLIPSIS` 的说明。
 */
describe('固定省略约定的协议安全边界：正文标点绝不触发切分', () => {
  const probe = (p: string) => locateExcerpt(`第一段内容${p}第二段内容`, '第一段内容第二段内容');

  it('★ 中文标点逐个探测：不触发切分', () => {
    const punctuation = [
      '。', '，', '、', '；', '：', '？', '！',
      '——', '·', '～',
      '（注）', '《书名》', '「引用」', '『略』', '（略）',
    ];
    for (const p of punctuation) {
      expect(probe(p).kind, `「${p}」不该触发切分`).not.toBe('segmented');
    }
  });

  it('★ 西文标点逐个探测：不触发切分', () => {
    const punctuation = ['.', ',', ';', ':', '?', '!', '-', '--', '---', '/', '"', "'"];
    for (const p of punctuation) {
      expect(probe(p).kind, `「${p}」不该触发切分`).not.toBe('segmented');
    }
  });

  it('★ 与正文同形的省略写法全部不触发切分 —— 它们是内容，不是约定', () => {
    const proseEllipses = ['…', '……', '...', '....', '。。。', '．．．'];
    for (const p of proseEllipses) {
      expect(probe(p).kind, `「${p}」是正文写法，不该触发切分`).not.toBe('segmented');
    }
  });

  it('★ 方括号 + 普通内容不触发切分 —— 约定只认特定括号族与「点 / 略」内容', () => {
    const lookalikes = ['[1]', '[注1]', '[略读]', '〔注〕', '【重点】', '[链接](url)', '［正文］'];
    for (const p of lookalikes) {
      expect(probe(p).kind, `「${p}」不是约定标记，不该触发切分`).not.toBe('segmented');
    }
  });

  it('★ 纯空白不触发切分（CJK 间空白走 T1 收拢，与约定无关）', () => {
    for (const p of [' ', '\n', '\t', '　']) {
      expect(probe(p).kind).not.toBe('segmented');
    }
  });

  it('★ 协议正向集：约定标记逐个触发切分（全角形态折叠后同样命中）', () => {
    const markers = ['〔略〕', '[略]', '【略】', '〔…〕', '[...]', '【…】', '［略］', '[．]'];
    for (const m of markers) {
      const r = probe(m);
      expect(r.kind, `「${m}」应触发切分`).toBe('segmented');
      expect(r.score).toBe(1);
    }
  });

  it('原文本身含约定标记时，逐字摘录仍精确命中（T0 优先于切分）', () => {
    // 协议代价的边界：文档若真的写着 〔略〕，逐字复制的摘录走 T0，
    // 不会因为标记被当成切分点而破坏坐标
    const doc = '他在文中写道〔略〕然后继续。';
    const r = locateExcerpt('他在文中写道〔略〕然后继续。', doc);
    expect(r.kind).toBe('exact');
    expect(r.index).toBe(0);
    expect(r.length).toBe(doc.length);
  });
});
