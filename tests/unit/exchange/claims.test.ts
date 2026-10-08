import { describe, expect, it } from 'vitest';
import {
  CLAIM_KINDS,
  MAX_CLAIM_ITEMS,
  MAX_CLAIM_TEXT,
  assertClaimsVerifiable,
  claimFactsFrom,
  parseClaims,
  type Claim,
  type ClaimFacts,
} from '@vca/api/modules/exchange/core/claims.js';
import { InvalidClaimsError } from '@vca/api/modules/exchange/core/errors.js';

/**
 * 承诺闭集（增量 A-6 / 规格 §6.1 / §6.3）。**纯函数，不需要数据库。**
 *
 * ## 这个文件问的是哪一件事
 *
 * 「作者说的话」今天没有任何核对（规格 §6.2）：dossier 的九项全是平台自己解析出来的，
 * 天生忠实。本节把「质量」翻译成一组**可机器核对的承诺**，而本文件钉住的是它的
 * **闭集边界**：什么能被声明、什么不能。
 *
 * ## §6.3 的两条纪律怎么落在这里
 *
 * * **「拒绝面必须与验收面成对」**：每一个非法形状都配一条**合法**的同形声明
 *   （同一个 `kind`、只改被拒的那个字段）。只写拒绝面时，一个把 `parseClaims` 写成
 *   `throw` 的实现也能骗过整个文件——「怎么都拒」与「逐条判对」在只有拒绝面的文件里
 *   长得一样。因此下面每一条 `it` 里都有 `正常 ⇒ 通过` 的一半。
 * * **「一条恒真的核对什么都没证明」**：`assertClaimsVerifiable` 的 fail-closed 那条
 *   有一个**反向对照**（`codeLines` 非 `null` 时同一条声明通过）——没有它，
 *   一个「永远抛」的实现照样让那条拒绝断言变绿。
 *
 * ## 据实记载：这里**没有** `judge`
 *
 * §6.3 还要求「每个断言都要有『声明为真 ⇒ 通过』与『声明为假 ⇒ 违约成立』两条用例」。
 * 那两条的主语是**审判**（`judge`），而 `judge` 的消费者在 P3.5（规格 §11.2 / §7.1）。
 * 本任务只交付 §6 的**声明侧**：闭集 + 解析 + 「一条核不动的声明不允许被提出」。
 * 今天在这里写一个 `judge` 就是 C16 禁止的投机抽象（零生产消费者）。
 */
describe('承诺闭集（增量 A-6 / 规格 §6.1）', () => {
  it('五个 kind 逐条可解析，且**往返无损**（parse → 再 parse 结果相同）', () => {
    const raw: readonly unknown[] = [
      { kind: 'paths_exist', paths: ['src/index.ts', 'README.md'] },
      { kind: 'entry_file_exists', path: 'src/index.ts' },
      { kind: 'dependency_manifest_parses', ecosystem: 'npm' },
      { kind: 'min_code_lines', min: 1200 },
      { kind: 'declared_stack', languages: ['TypeScript', 'CSS'] },
    ];

    const parsed = parseClaims(raw);
    expect(parsed).not.toBeNull();
    // 非空转前提：五条**都**解析出来了，而不是「解析器返回了一个短数组」。
    expect(parsed).toHaveLength(CLAIM_KINDS.length);
    expect(parsed?.map((claim) => claim.kind)).toEqual([...CLAIM_KINDS]);

    // 往返无损：解析结果**再解析一次**得到逐字段相同的值。
    // 没有这一条时，一个「把输入原样存下来」的实现也能过——而它会把未知字段与
    // 未规范化的取值一起带进 JSONB 列，于是「闭集」只是一句注释。
    expect(parseClaims(parsed)).toEqual(parsed);

    // 每一个 kind 都在闭集里（防止 `CLAIM_KINDS` 与 `Claim` 联合类型漂移）。
    for (const claim of parsed as readonly Claim[]) {
      expect(CLAIM_KINDS).toContain(claim.kind);
    }
  });

  it('闭集外的 kind ⇒ InvalidClaimsError（自由文本声明会让机器审判退化成口水仗）', () => {
    expect(() => parseClaims([{ kind: 'quality_is_good' }])).toThrow(InvalidClaimsError);
    // 验收对照：同一条声明换成闭集内的 kind ⇒ **通过**。
    // 没有它，「`kind` 怎么写都抛」的实现也能让上面那条变绿。
    expect(parseClaims([{ kind: 'entry_file_exists', path: 'a.ts' }])).toEqual([
      { kind: 'entry_file_exists', path: 'a.ts' },
    ]);
  });

  it('缺 kind / kind 不是字符串 ⇒ InvalidClaimsError（两条拒绝面 + 两条验收对照）', () => {
    expect(() => parseClaims([{ path: 'a.ts' }])).toThrow(InvalidClaimsError);
    expect(() => parseClaims([{ kind: 7 }])).toThrow(InvalidClaimsError);
    expect(parseClaims([{ kind: 'entry_file_exists', path: 'b.ts' }])).toHaveLength(1);
    expect(parseClaims([{ kind: 'min_code_lines', min: 1 }])).toHaveLength(1);
  });

  it('闭集内 kind 的**多余键**被拒（闭集不只在 kind 上，也在字段上）', () => {
    // 一个陌生的键进了 JSONB 就再也说不清它是什么——而 P3.5 的 `judge` 会逐条读这张表。
    expect(() => parseClaims([{ kind: 'entry_file_exists', path: 'a.ts', note: '顺便说一句' }])).toThrow(
      InvalidClaimsError,
    );
    expect(parseClaims([{ kind: 'entry_file_exists', path: 'a.ts' }])).toHaveLength(1);
  });

  it('空数组 ⇒ InvalidClaimsError（`paths_exist` / `declared_stack` 各自一条验收对照）', () => {
    // 空集声明是一条**恒真**的核对（「这些路径都存在」在空集上无条件成立），
    // 而规格 §6.3 明写「一条恒真的核对什么都没证明」。
    expect(() => parseClaims([{ kind: 'paths_exist', paths: [] }])).toThrow(InvalidClaimsError);
    expect(() => parseClaims([{ kind: 'declared_stack', languages: [] }])).toThrow(InvalidClaimsError);
    expect(parseClaims([{ kind: 'paths_exist', paths: ['src/a.ts'] }])).toHaveLength(1);
    expect(parseClaims([{ kind: 'declared_stack', languages: ['Go'] }])).toHaveLength(1);
  });

  it('空字符串 / 非字符串 ⇒ InvalidClaimsError（`entry_file_exists` / `dependency_manifest_parses` 各一条对照）', () => {
    expect(() => parseClaims([{ kind: 'entry_file_exists', path: '' }])).toThrow(InvalidClaimsError);
    expect(() => parseClaims([{ kind: 'entry_file_exists', path: '   ' }])).toThrow(InvalidClaimsError);
    expect(() => parseClaims([{ kind: 'entry_file_exists', path: 42 }])).toThrow(InvalidClaimsError);
    expect(() => parseClaims([{ kind: 'dependency_manifest_parses', ecosystem: '' }])).toThrow(InvalidClaimsError);
    expect(parseClaims([{ kind: 'entry_file_exists', path: 'src/index.ts' }])).toHaveLength(1);
    expect(parseClaims([{ kind: 'dependency_manifest_parses', ecosystem: 'npm' }])).toHaveLength(1);
  });

  it('非正数 / 非整数 ⇒ InvalidClaimsError（`min_code_lines` 的验收对照与拒绝面成对）', () => {
    for (const min of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      expect(() => parseClaims([{ kind: 'min_code_lines', min }]), `min=${String(min)} 必须被拒`).toThrow(
        InvalidClaimsError,
      );
    }
    // 验收对照：`1` 是最小的合法下界（「至少一行代码」）。
    expect(parseClaims([{ kind: 'min_code_lines', min: 1 }])).toEqual([{ kind: 'min_code_lines', min: 1 }]);
  });

  it('超长列表 / 超长字符串 ⇒ InvalidClaimsError（长度是**便宜的前置筛**，先于逐条核对）', () => {
    const okPaths = Array.from({ length: MAX_CLAIM_ITEMS }, (_, i) => `src/f${String(i)}.ts`);
    const tooManyPaths = [...okPaths, 'src/one-too-many.ts'];
    // 恰好上限 ⇒ 通过（界是**闭**的：改小一位会误伤合法声明，改大一位会让「上限」名不副实）。
    expect(parseClaims([{ kind: 'paths_exist', paths: okPaths }])).toHaveLength(1);
    expect(() => parseClaims([{ kind: 'paths_exist', paths: tooManyPaths }])).toThrow(InvalidClaimsError);

    const okLanguages = Array.from({ length: MAX_CLAIM_ITEMS }, (_, i) => `Lang${String(i)}`);
    expect(parseClaims([{ kind: 'declared_stack', languages: okLanguages }])).toHaveLength(1);
    expect(() =>
      parseClaims([{ kind: 'declared_stack', languages: [...okLanguages, 'OneTooMany'] }]),
    ).toThrow(InvalidClaimsError);

    expect(parseClaims([{ kind: 'entry_file_exists', path: 'a'.repeat(MAX_CLAIM_TEXT) }])).toHaveLength(1);
    expect(() => parseClaims([{ kind: 'entry_file_exists', path: 'a'.repeat(MAX_CLAIM_TEXT + 1) }])).toThrow(
      InvalidClaimsError,
    );
  });

  it('列表里的空白项 / 重复项 ⇒ InvalidClaimsError（一对验收对照）', () => {
    expect(() => parseClaims([{ kind: 'paths_exist', paths: ['src/a.ts', '  '] }])).toThrow(InvalidClaimsError);
    expect(parseClaims([{ kind: 'paths_exist', paths: ['src/a.ts', 'src/b.ts'] }])).toHaveLength(1);
  });

  it('`null` / `undefined` ⇒ 返回 `null`（= **没有声明**），而 `[]` 是一个**空集**', () => {
    // 与 `swap_offers.claims` 的可空性同一条纪律（Task 5.5 的列注释）：
    // 「这份要约什么都没承诺」与「它承诺了零条」不是同一件事，因此两个值都必须是
    // **可表达的**，而且**互不相等**。
    expect(parseClaims(null)).toBeNull();
    expect(parseClaims(undefined)).toBeNull();
    expect(parseClaims([])).toEqual([]);
    expect(parseClaims([])).not.toBeNull();

    // 非数组的取值 ⇒ 拒绝（不能悄悄当成「没有声明」）。
    for (const bad of ['', 'null', 0, {}, [{ kind: 'paths_exist', paths: 'src/a.ts' }]]) {
      expect(() => parseClaims(bad), `${JSON.stringify(bad)} 不是一份声明`).toThrow(InvalidClaimsError);
    }
  });

  it('★ `min_code_lines` 而 `code_lines` 为 null ⇒ assertClaimsVerifiable 抛（声明侧 fail-closed）', () => {
    const claims = parseClaims([{ kind: 'min_code_lines', min: 100 }]) as readonly Claim[];
    expect(() => assertClaimsVerifiable(claims, facts({ codeLines: null }))).toThrow(InvalidClaimsError);
    // 反向对照：`code_lines` 非 null 时同一条声明**通过**。
    // 没有它，一个「永远抛」的实现能让上面那条变绿，而那样**所有**声明都提不出来。
    expect(() => assertClaimsVerifiable(claims, facts({ codeLines: 0 }))).not.toThrow();
    expect(() => assertClaimsVerifiable(claims, facts({ codeLines: 99 }))).not.toThrow();
  });

  it('其余四条声明在 `code_lines` 为 null 时**照样**核得动（fail-closed 的半径恰好是那一条）', () => {
    // 这四条的事实来源是 `file_tree` / `dependencies` / `languages`，它们**都是非空列**，
    // 因此不存在「迁移之前的旧行」这一说。把 fail-closed 扩大到这四条会拒掉合法声明。
    const claims = parseClaims([
      { kind: 'paths_exist', paths: ['src/index.ts'] },
      { kind: 'entry_file_exists', path: 'src/index.ts' },
      { kind: 'dependency_manifest_parses', ecosystem: 'npm' },
      { kind: 'declared_stack', languages: ['TypeScript'] },
    ]) as readonly Claim[];
    expect(() => assertClaimsVerifiable(claims, facts({ codeLines: null }))).not.toThrow();
  });

  it('`claimFactsFrom` 从**读回来的那一行**抽取四个事实（判据不自己去查库、不自己挑字段）', () => {
    const metadata = {
      assetVersionId: '01920000-0000-7000-8000-000000000001',
      readmeExcerpt: '# hi',
      fileTree: [{ path: 'src/index.ts', bytes: 12 }],
      languages: [{ name: 'TypeScript', bytes: 12, ratio: 1 }],
      dependencies: [{ ecosystem: 'npm', name: 'zod', version: '4.6.5' }],
      completeness: 40,
      fileTreeTruncated: false,
      codeLines: 7,
    };
    expect(claimFactsFrom(metadata)).toEqual({
      fileTree: [{ path: 'src/index.ts', bytes: 12 }],
      languages: [{ name: 'TypeScript' }],
      dependencies: [{ ecosystem: 'npm' }],
      codeLines: 7,
    });
    // 旧行（`code_lines` 是 NULL）原样成为 `null`：**不是** `0`。
    expect(claimFactsFrom({ ...metadata, codeLines: null }).codeLines).toBeNull();
  });
});

/** 一份「什么都没有」的事实（每一条用例只覆盖它关心的那一格）。 */
function facts(overrides: Partial<ClaimFacts>): ClaimFacts {
  return {
    fileTree: [],
    languages: [],
    dependencies: [],
    codeLines: null,
    ...overrides,
  };
}
