import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
  createStreamingStorage,
  type UploadSink,
  type UploadedArtifact,
} from '@vca/api/common/upload/stream-upload.js';

/**
 * 上传适配器（`common/upload/stream-upload.ts`）的行为契约。
 *
 * ## 为什么它需要自己的用例（集成测试覆盖不到的那部分）
 *
 * 集成测试跑的是「一路成功」与「超限 413」两条路径，而**超限时 `_removeFile`
 * 一次都不会被调用**——变异探针 IMP3（把 `_removeFile` 换成空实现）实测：
 * 集成套件 6 条全绿。原因见 `asset.module.ts`：超限时先中止的是存储层，
 * 它自己删掉了已写入的部分，multer 于是不再要求引擎清理。
 *
 * 但 `_removeFile` 是**真实可达**的路径（实测，见任务报告的探针 C1）：`_handleFile`
 * 报告成功之后 multer 才决定中止时（客户端在响应前断开、`limits.files`/`parts` 触发），
 * multer 会把引擎返回的键交回来要求删除。删不掉就泄漏一个对象，而**没有任何测试会红**。
 * 因此这里用假 sink 直接钉住它。
 *
 * ## 另一条被钉住的性质：回调必须恰好被调用一次
 *
 * multer 的中间件不是 async 的：它靠 `callback` 继续，并用「未完成写入数」判断能否收尾。
 * 引擎回调**永不触发**的失效形态是请求**挂住**（不是报错）——比报错难查得多。
 */
interface SinkCalls {
  put: Array<{ bytes: number; maxBytes: number }>;
  deleted: string[];
}

function fakeSink(behaviour: {
  onPut?: () => Promise<{ key: string; bytes: number }> | { key: string; bytes: number };
  onDelete?: (key: string) => Promise<void>;
}): { sink: UploadSink; calls: SinkCalls } {
  const calls: SinkCalls = { put: [], deleted: [] };
  const sink: UploadSink = {
    async putStream(source, opts) {
      calls.put.push({ bytes: 0, maxBytes: opts.maxBytes });
      // 真实现会消费流；这里也消费掉，否则「流永远不被读」会让某些实现挂住。
      let bytes = 0;
      for await (const chunk of source) bytes += (chunk as Buffer).length;
      calls.put[calls.put.length - 1]!.bytes = bytes;
      return behaviour.onPut ? await behaviour.onPut() : { key: 'fake-key', bytes };
    },
    async delete(key) {
      calls.deleted.push(key);
      await behaviour.onDelete?.(key);
    },
  };
  return { sink, calls };
}

/** 调用 `_handleFile` 并等它的回调（超时即失败：回调不来就是「请求会挂住」）。 */
function handleFile(
  engine: ReturnType<typeof createStreamingStorage>,
  stream: Readable,
): Promise<{ error: Error | null; info?: UploadedArtifact }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('_handleFile 的回调没有在 2 秒内被调用（请求会挂住）')), 2000);
    engine._handleFile({}, { stream }, (error, info) => {
      clearTimeout(timer);
      resolve({ error, info });
    });
  });
}

/** 调用 `_removeFile` 并等它的回调。 */
function removeFile(
  engine: ReturnType<typeof createStreamingStorage>,
  file: { key?: unknown },
): Promise<{ error: Error | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('_removeFile 的回调没有在 2 秒内被调用')), 2000);
    engine._removeFile({}, file, (error) => {
      clearTimeout(timer);
      resolve({ error });
    });
  });
}

describe('createStreamingStorage（Task 1）', () => {
  it('_handleFile：把 part 流交给 sink，并把键与字节数回给 multer', async () => {
    const { sink, calls } = fakeSink({});
    const engine = createStreamingStorage(sink, { maxBytes: 1024 });

    const { error, info } = await handleFile(engine, Readable.from([Buffer.alloc(300, 1), Buffer.alloc(200, 2)]));

    expect(error).toBeNull();
    expect(info).toEqual({ key: 'fake-key', bytes: 500 });
    expect(calls.put).toEqual([{ bytes: 500, maxBytes: 1024 }]);
  });

  it('_handleFile：sink 抛错时把**同一个**错误交给回调（而不是吞掉或换一个）', async () => {
    const boom = new Error('制品超过上限：1024 字节');
    const { sink } = fakeSink({
      onPut: () => {
        throw boom;
      },
    });
    const engine = createStreamingStorage(sink, { maxBytes: 1024 });

    const { error, info } = await handleFile(engine, Readable.from([Buffer.alloc(8)]));

    expect(error).toBe(boom);
    expect(info).toBeUndefined();
  });

  it('_removeFile：按键删除（引擎报成功后 multer 才中止时唯一不泄漏对象的机会）', async () => {
    const { sink, calls } = fakeSink({});
    const engine = createStreamingStorage(sink, { maxBytes: 1024 });

    const { error } = await removeFile(engine, { key: 'obj-1' });

    expect(error).toBeNull();
    expect(calls.deleted).toEqual(['obj-1']);
  });

  it('_removeFile：没有键（写入没走到「有对象」那一步）⇒ 空操作，不删任何东西', async () => {
    const { sink, calls } = fakeSink({});
    const engine = createStreamingStorage(sink, { maxBytes: 1024 });

    expect(await removeFile(engine, {})).toEqual({ error: null });
    expect(await removeFile(engine, { key: '' })).toEqual({ error: null });
    expect(await removeFile(engine, { key: 42 })).toEqual({ error: null });
    expect(calls.deleted).toEqual([]);
  });

  it('_removeFile：删除失败时把错误交给回调（multer 会记进 error.storageErrors，不吞）', async () => {
    const boom = new Error('删除失败');
    const { sink } = fakeSink({
      onDelete: () => {
        throw boom;
      },
    });
    const engine = createStreamingStorage(sink, { maxBytes: 1024 });

    expect(await removeFile(engine, { key: 'obj-2' })).toEqual({ error: boom });
  });

  it('非 Error 的抛值也会被收敛成 Error（multer 的类型契约不接受原始值）', async () => {
    const { sink } = fakeSink({
      onPut: () => {
        throw '字符串异常';
      },
    });
    const engine = createStreamingStorage(sink, { maxBytes: 1024 });

    const { error } = await handleFile(engine, Readable.from([Buffer.alloc(1)]));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('字符串异常');
  });
});
