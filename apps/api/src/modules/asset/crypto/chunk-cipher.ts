import { createCipheriv, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import {
  CHUNK_SIZE,
  FILE_ID_BYTES,
  FORMAT_VERSION,
  INDEX_ENTRY_SIZE,
  NONCE_PREFIX_BYTES,
  TAG_BYTES,
  buildAad,
  deriveNonce,
  encodeIndex,
  headerByteLength,
  type ArtifactHeader,
  type IndexEntry,
} from './artifact-format.js';
import type { KeyRing } from './key-ring.js';

/**
 * 流式分块加密器（P1 / Task 2，规格 D2/D3/D4/D5）。
 *
 * ## 它产出什么（跨任务契约，Task 3 与 Task 5 都按这条读）
 *
 * - `transform()` 产出的是**块数据字节流**：逐块 `ciphertext || tag(16)`，
 *   不含文件头、不含块索引；
 * - `result()` 在流**成功结束之后**给出 `{ header, index }`，两者是最终制品里
 *   `[头][索引][块数据]` 的前两段。
 *
 * 因此「把三段拼成一个对象」是**写入方（Task 5）的事**。这不是实现取舍，而是格式的
 * 结构性后果：头里带着 `plaintextLength` / `chunkCount`（流结束才知道），
 * 而格式要求头排在块数据**之前**，所以单趟前向写一个顺序目标流**不可能**同时满足两者。
 * `ArtifactStore.putStream` 今天没有「按偏移改写」或「追加」的能力，Task 5 必须选一条路
 * （预留区 + 回填 / 先写密文再二次过 / 给存储端口加写偏移），已记入报告的 Concerns。
 *
 * ## 为什么必须「押后一块」（hold-back）
 *
 * 末块的 AAD 是 `last`，而**一块填满的那一刻我们并不知道它是不是末块**：
 * 后面可能还有数据。若在填满时立刻按 `more` 发射，那么「明文长度恰好是块大小整数倍」
 * 的文件，其真正的末块会带着 `more` 的 AAD —— 读取端按 `last` 去认证就会失败，
 * **整份制品解不开**。这不是罕见边界：生产上限 1 GiB 恰好是 8 MiB 的 **128 倍**，
 * 也就是说**每一次顶格上传都属于这一类**。
 *
 * 修法是押后一块：填满的块先留在手里（`held`），等下一块开始填时才确认它不是末块、
 * 按 `more` 发射；流结束时手里的那块就是末块，按 `last` 发射。代价是同时存在两块缓冲
 * （`2 × chunkSize`），而不是一块。
 *
 * ## 两个已实测的性能/内存事实（8 MiB 真实块大小，`evidence/t2-probe-crypto-8mib.txt`）
 *
 * 1. **攒块必须用「预分配缓冲 + copy」，不能用 `Buffer.concat([acc, chunk])`**：
 *    预检用 64 KiB 块时两种写法没有区别，而在 8 MiB 块下实测
 *    **284 MiB/s vs 39 MiB/s（差 7.4 倍）**——后者每来一小块就把已有内容整体拷贝一次，
 *    是 O(n²)。这条差异**只有把块大小提到真实值才看得见**。
 * 2. **内存判据是未完成字节数**：16 / 64 / 128 MiB 三种输入的峰值都是
 *    `8,454,144 = 2 × CHUNK_SIZE + 64 KiB`（一个源块），与输入大小无关；
 *    同一批测量的 RSS 增量符号都不同（+32.7 / +8.0 / −33.9 MiB），不可用作判据。
 *
 * ## 与 `ChunkDecipher`（Task 3）的分工
 *
 * 本类只写。它不实现解密、不做位置序号校验（C20 是读取端的契约）——但它**承重**：
 * 位置进 nonce、`isLast` 进 AAD、`keyId` 进头部，这三件事写错，读取端无论怎么写都对不上。
 */
export class ChunkEncryptor {
  private readonly keyId: string;
  private readonly key: Buffer;
  private readonly fileId: Buffer;
  private readonly noncePrefix: Buffer;
  private readonly chunkSize: number;

  /**
   * 加密过程中的**可变状态**，刻意集中在一个对象里。
   *
   * 为什么不是一个字段一个字段地写：`transform()` 的回调必须是**普通函数**
   * （回调里的 `this` 要是 Transform，才能 `push`），而加密器的状态要跨越这些回调共享。
   * 最顺手的写法是 `const encryptor = this`，但那会被
   * `@typescript-eslint/no-this-alias` 判错（实测，本仓库 lint 门是 error）。
   * 共享一个状态对象既避开别名，也让「哪些字段会变」一眼可见
   * —— `keyId` / `key` / `fileId` / `noncePrefix` / `chunkSize` 反而是只读的。
   */
  private readonly state: {
    /** 已喂入的明文总字节数（只有流成功结束之后它才是最终值）。 */
    plaintextLength: bigint;
    /** 每块的**明文**长度，发射顺序。索引里的 `ciphertextLength` 就是它（不含 tag）。 */
    blockLengths: number[];
    /** 流是否**成功**结束。未结束或出错时为 false，`result()` 据此拒绝出结果。 */
    finished: boolean;
  } = { plaintextLength: 0n, blockLengths: [], finished: false };

  private transformTaken = false;
  private cached?: { header: ArtifactHeader; index: Buffer };

  /**
   * @param keyRing 密钥环。构造期就会 `keyFor(activeKeyId())` —— **取不到活动键立刻抛错**，
   *   而不是等到第一个字节（那时上传已经在进行，失败代价更大）。
   * @param opts.chunkSize 覆盖块大小（默认 {@link CHUNK_SIZE}）。块大小会写进文件头，
   *   因此它是**自描述**的：测试用小块跑得快，读取端按头里的值解析，两者不会错配。
   */
  constructor(keyRing: KeyRing, opts: { chunkSize?: number } = {}) {
    const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
    // 宽度按写入头的 uint32 收口，语义按「正整数」收口：0 会让 chunkCount 无法定义。
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 0xffffffff) {
      throw new RangeError(`chunkSize 必须是 1..2^32-1 的整数：${chunkSize}`);
    }
    this.chunkSize = chunkSize;
    this.keyId = keyRing.activeKeyId();
    // 「缺失活动键 ⇒ 抛错，绝不回退到默认键」（D5）：回退会让轮换静默失效，
    // 失效形态是「新制品头里写着 v1、实际用 v2 加密」，且没有任何一层会报错。
    this.key = keyRing.keyFor(this.keyId);
    this.fileId = randomBytes(FILE_ID_BYTES);
    // 每文件随机的 4 字节前缀：跨文件 nonce 唯一性**只**靠它（规格 D4）。
    this.noncePrefix = randomBytes(NONCE_PREFIX_BYTES);
  }

  /**
   * 写入侧的 Transform：吃明文片段，吐 `ciphertext || tag` 记录。
   *
   * 只允许调用一次——同一次加密有两个出口意味着两套 `held`/`position` 状态，
   * 那一定会写出一份自相矛盾的制品（重复的块序号 + 对不上的计数）。
   */
  transform(): Transform {
    if (this.transformTaken) {
      throw new Error('ChunkEncryptor.transform() 只能调用一次（一次加密只有一个出口）');
    }
    this.transformTaken = true;

    // 回调里的 `this` 是 **Transform**（要 `push`），加密器本身**不**用 `this` 取：
    // 需要的东西在下面按值/按引用捕获（`state` 是对象，按引用共享）。
    // 第一版把两者混着用，实测报 `TypeError: self.push is not a function`。
    const state = this.state;
    const { chunkSize, key, fileId, noncePrefix } = this;
    /**
     * 已经填满、但还不知道是不是末块的那一块。
     *
     * 类型必须显式写成 `Buffer`（= `Buffer<ArrayBufferLike>`）：`Buffer.allocUnsafe()` 的
     * 推断类型是 `Buffer<ArrayBuffer>`，而两块缓冲在下面**互换**，于是「把 `held` 赋给
     * `filling`」会因为 `ArrayBufferLike` 不能赋给 `ArrayBuffer` 而报 TS2322
     * （实测：`pnpm vitest` 全绿、`pnpm typecheck`/`build` 报错——这正是 K14 说的那件事）。
     */
    let held: Buffer | null = null;
    /** 正在填的块；与 `held` 在每次填满时互换，避免每块都新分配 8 MiB。 */
    let filling: Buffer = Buffer.allocUnsafe(chunkSize);
    let filled = 0;
    let position = 0;

    /** 加密一块并按记录（密文 + tag）发射。**唯一**决定 nonce/AAD 的地方。 */
    const emit = (out: Transform, block: Buffer, isLast: boolean): void => {
      const cipher = createCipheriv('aes-256-gcm', key, deriveNonce(noncePrefix, position));
      cipher.setAAD(buildAad(fileId, position, isLast));
      const ciphertext = cipher.update(block);
      cipher.final(); // GCM 的 final() 不产出字节，但 getAuthTag() 必须在它之后调用
      const tag = cipher.getAuthTag();
      state.blockLengths.push(block.length);
      position += 1;
      // 一次 push 一条记录：字节流顺序不变，而「记录边界」对下游可观察
      // （存储层只数字节，但读取器按块读，边界一致更不容易出错）。
      out.push(Buffer.concat([ciphertext, tag]));
    };

    return new Transform({
      transform(chunk: Buffer, _encoding, callback: (error?: Error | null) => void): void {
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const take = Math.min(chunkSize - filled, chunk.length - offset);
            chunk.copy(filling, filled, offset, offset + take);
            filled += take;
            offset += take;

            if (filled === chunkSize) {
              // 这一块满了 ⇒ 手里那块一定**不是**末块（它后面还有至少一整块）
              if (held !== null) emit(this, held, false);
              const recycled = held;
              held = filling;
              filling = recycled ?? Buffer.allocUnsafe(chunkSize);
              filled = 0;
            }
          }
          state.plaintextLength += BigInt(chunk.length);
          callback();
        } catch (error) {
          // 加密失败（密钥长度被改坏、内存不足…）：让管道以错误结束，
          // 而不是吞掉它继续产出残缺的密文。
          callback(error as Error);
        }
      },
      flush(callback: (error?: Error | null) => void): void {
        try {
          if (filled > 0) {
            // 尾巴不满：手里那块不是末块，最后这段才是
            if (held !== null) emit(this, held, false);
            emit(this, filling.subarray(0, filled), true);
          } else if (held !== null) {
            // 恰好整数块：手里那块就是末块（`last` 标记就是在这里落下的）
            emit(this, held, true);
          }
          // 0 字节输入走到这里什么都不发：chunkCount = 0、空索引
          state.finished = true;
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    });
  }

  /**
   * 流**成功结束之后**的最终结果：文件头与块索引。
   *
   * 未结束（或流以错误结束）时**抛错**：此时 `plaintextLength` / `chunkCount` 都不是最终值，
   * 报出去的头会让调用方写下一份「自称 N 块、实际只有 M 块」的制品——那是截断，不是结果。
   *
   * 头里的 `fileId` / `noncePrefix` 是**本对象持有的那两个**缓冲（重复调用返回同一份）。
   * 这与「不可信输入」无关：它们由本对象生成，而不是从外部读入；
   * `encodeHeader` 会把它们拷进编码结果，因此调用方即使改写也不会污染制品。
   */
  result(): { header: ArtifactHeader; index: Buffer } {
    if (!this.state.finished) {
      throw new Error(
        'ChunkEncryptor.result() 在流尚未成功结束前被调用：plaintextLength / chunkCount 此时不是最终值',
      );
    }
    if (this.cached === undefined) {
      const keyIdBytes = Buffer.byteLength(this.keyId, 'utf8');
      const blockLengths = this.state.blockLengths;
      const chunkCount = BigInt(blockLengths.length);
      // 块数据的起点 = 头 + 整份索引。索引长度**依赖最终的块数**，
      // 所以 offset 只能在这里算——发射时算不出来（那时还不知道后面有几块）。
      let offset = BigInt(headerByteLength(keyIdBytes) + blockLengths.length * INDEX_ENTRY_SIZE);
      const entries: IndexEntry[] = blockLengths.map((plaintextBytes) => {
        const entry: IndexEntry = { offset, ciphertextLength: plaintextBytes };
        offset += BigInt(plaintextBytes + TAG_BYTES);
        return entry;
      });

      this.cached = {
        header: {
          formatVersion: FORMAT_VERSION,
          keyId: this.keyId,
          fileId: this.fileId,
          chunkSize: this.chunkSize,
          plaintextLength: this.state.plaintextLength,
          chunkCount,
          noncePrefix: this.noncePrefix,
        },
        index: encodeIndex(entries),
      };
    }
    return this.cached;
  }
}
