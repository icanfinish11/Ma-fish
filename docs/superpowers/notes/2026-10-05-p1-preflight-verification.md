# P1 依赖与工具链预检（2026-10-05）

**目的**：在写 P1 计划之前，用可运行探针把「计划会写错的假设」先打掉。P0 期间有十余个缺陷是这一步抓出来的，而不是等写代码时才发现。

**探针位置**：`.spike-p1/`（一次性，验完即弃，不入库）。
**结论状态**：以下每条都有实际输出为证，不是查阅文档得出的。

---

## 1. 恶意压缩包防御：**可以在解压任何数据之前判定**

设计文档威胁 #2 的六条限制（累计 ≤1GB、条目 ≤20,000、压缩比 ≤100:1、拒绝对路径 / `..` / symlink、仅 zip 与 tar.gz 且 magic bytes 确认）全部实测可执行，且**全部样本无任何文件落地**。

样本集与实测判定（`probe-archive.ts`）：

| 样本 | 判定 | 拦截机制 |
|---|---|---|
| `zip-slip.zip`（`../../../../etc/evil.txt` + 绝对路径） | 拒绝 | **yauzl 内置**防护：open 阶段即抛 `invalid relative path` |
| `symlink.zip`（外部属性 Unix mode `0o120777`） | 拒绝 | 我的外部属性检查 |
| `bomb.zip`（100MB 零字节，实测比 **1029:1**） | 拒绝 | 压缩比，**只读中央目录，未解压一个字节** |
| `flood.zip`（20,001 条目） | 拒绝 | 条目数 > 20,000 |
| `fake-mime.zip`（PNG 内容伪装 .zip） | 拒绝 | 结构解析失败 |
| `ok.zip` | 接受 | — |
| `ok.tar.gz` | 接受 | — |
| `bomb.tar.gz`（同炸弹，实测比 **1028:1**） | 拒绝 | 压缩比，**仅凭 tar 头部** |
| 落盘检查 | **OUT_DIR_ENTRIES=0** | 全程无文件落地 |

### 1.1 关键机制发现

1. **zip：中央目录包含全部条目元数据**（名字、未压缩大小、压缩大小、外部属性），因此三条聚合限制**无需解压**即可判定。`yauzl` 的 `lazyEntries` 模式只读目录。
2. **tar.gz：没有中央目录**，只能流式判定。但 **tar 条目头里声明的 size 就是解析器的分帧依据**，所以累计大小与压缩比同样可以仅凭头部判定 —— 炸弹在解压出几百字节时就被中止，而非把 100MB 全解出来。
3. **yauzl 自带 zip-slip 防护**（`validateFileName`，已导出）。⇒ **解析器抛错必须计为「拒绝」，不能让进程崩掉**，否则一次恶意上传就是一次未处理异常。但**不能只依赖它**：它不覆盖 symlink，也不覆盖聚合限制。
4. **`file-type` 对 gzip 压缩的 tar 返回 `{ ext: 'tar.gz', mime: 'application/gzip' }`，不是 `'gz'`。** 探针第一版写成 `sniffed !== 'gz'`，结果**把 100% 的合法 tar.gz 上传全部误拒**，并且让整条 tar.gz 流式路径根本没被执行到（两个样本都在 sniff 处短路）。这是一个会在生产里立刻炸、在测试里却可能被"预期拒绝"掩盖的错误。
5. **tar 包的 Parser 用 `'entry'` 事件**，不是 tar-stream 的 `onentry` 回调。用错 API 时 **`onentry` 静默不触发、pipeline 永不 settle** —— 不报错，只是挂住。
6. **流式校验的提前中止必须销毁上游**：
   - 仅「不再消费条目」⇒ 解析器卡死，`pipeline` 永不 settle；
   - 「无脑 drain」⇒ 等于把炸弹完整解压一遍；
   - `tar.Parser` **没有 `destroy()`**，只能销毁 `source`/`gunzip`，并**立刻 settle 自己的 promise**（`pipeline` 在目标流于条目回调内被销毁时不会 settle）。
   - 正确的读取方式：显式 settle-once，而不是 `pipeline`。
7. **`yauzl.fromRandomAccessReader` 与抽象类 `RandomAccessReader` 都存在**（另有 `openPromise`/`fromBufferPromise` 等 Promise API）。这是下面第 3 节架构的使能条件。

---

## 2. AES-256-GCM 分块加密：**发现一个必须写进设计的缺陷**

威胁 #3 要求块大小 8MB、每块独立 nonce、key id 前缀支持轮换。往返与篡改检测都通过，但探针**发现重排攻击未被拦截**（`probe-crypto.ts`）：

| 检查 | 实测结果 |
|---|---|
| 往返一致 | true（197,842 字节 / 4 块） |
| 篡改任一块密文 | 通过（点名 `chunk 1 认证失败`） |
| **重排两块（信任记录自称序号）** | **未发现，且明文已被重排 = true** ← 缺陷 |
| 重排（序号取自读取位置） | 通过（`位置 0 处的记录自称序号 1`） |
| 截断末块 | 通过（`chunk 2 认证失败`） |
| 每块 nonce 唯一 | 4/4 |
| 跨文件 nonce 无重用 | true |
| 相同明文两次加密密文不同 | true |
| 流式 64MB / 1024 块 | 输出 64.0MB，RSS 峰值增量 46MB |

### 2.1 缺陷与修法（**必须写进设计**）

若解密时用**记录里自称的块序号**去推导 nonce 与 AAD，那么攻击者只要把两条存储记录**整体调换**，AAD 的输入也随之被调换，**认证通过、明文顺序被静默重排**。

**修法**：块序号必须取自**读取位置**（`expected`），并显式校验 `rec.index === pos`；AAD 也由位置推导。这样调换记录会在位置 0 处发现「自称序号 1」而被拒。

> 这条是本次预检最有价值的产出：它不是「实现细节」，而是**格式与读取器之间的契约**。若等到实现阶段才发现，会变成一次跨模块返工。

### 2.2 nonce 方案（已验证）

`4 字节每文件随机前缀 + 8 字节块序号（大端）`。同文件内块序号唯一 ⇒ nonce 唯一；跨文件靠随机前缀区分。**绝不能**用「固定前缀 + 从 0 开始的计数器」跨文件复用（GCM 下 nonce 重用会泄露明文异或）。

### 2.3 已知边界（如实记录）

- 流式 64MB 的 RSS 峰值增量为 46MB。这是 `rss` 的口径问题（含 GC 未归还页），**不是** O(文件大小) 的证据；结构性上界由块大小决定（生产 8MB），与文件总大小无关。实现时应以「未完成字节数」而非 RSS 来断言内存上界。
- 探针用 64KB 块以便快速迭代，生产用 8MB；机制与块大小无关，但**8MB 块下的 AAD/nonce 逻辑必须在实现时用真实块大小再验一次**。
- 探针把记录放在内存数组里。真实存储布局（头 + 逐块 nonce/tag 偏移索引）**尚未设计**，属于计划要解决的问题。

---

## 3. 由预检得出的架构决定：**加密即入库，再解密校验**

zip 的中央目录在文件**末尾**，因此**单趟前向流无法校验 zip**。可选方案中，唯一同时满足「不把明文落盘」与「不把 1GB 读进内存」的是：

1. 客户端流式上传 → 先嗅探 magic bytes → **立即流式加密写入制品库**（明文从不落盘、从不整份进内存）。
2. 校验时用 `yauzl.fromRandomAccessReader` 实现一个 `RandomAccessReader`，**按需解密所需块**（zip 先读尾部中央目录）。
3. 校验失败 ⇒ **删除已写入的密文对象**并返回错误。明文自始至终没有以文件形式存在过。
4. 校验通过 ⇒ 用同一个随机访问读取器解析元数据（README、文件树、语言分布、依赖），写库。

**这比「先落盘临时明文再删」强得多**：被拒的上传连明文临时文件都不存在。验收 §13.2 的「无任何文件落地」因此是**结构性成立**，而非靠清理逻辑。

**待计划解决**：存储布局与块索引格式、`RandomAccessReader` 的接口映射、以及"校验失败删除"的失败路径（删除本身失败时怎么办）。

---

## 4. 仍未预检的项（计划中标注、实现时先验）

- ~~**上传路径**：NestJS 12 / Express 5 下的 multipart 流式接入与硬性大小上限（`multer` 2.4.0 的存储引擎选择）。**这是 P1 最大的未验证面**。~~
  **已由 Task 1 预检并回填，见 §6**。结论一句话：自定义 storage engine 可以真流式（不落临时文件、不整份进内存），`limits.fileSize` 回 413，但**报错前 multer 会把整个请求体读完**。
- **签名下载 URL**：HMAC + ≤5 分钟 TTL + 单次使用（Redis）。机制常规，风险低。
- **元数据解析**：README/文件树/语言分布/依赖，纯静态、绝不执行（C2）。风险低。

---

## 5. 对计划的直接影响（必须体现）

1. 归档校验器的**正确性判据是样本集全拒 + 零落盘**，测试要覆盖上述八个样本（含两个**合法**样本必须被接受 —— 否则「全拒」也能骗过测试）。
2. `file-type` 的 gzip 判定用 `ext === 'tar.gz' || mime === 'application/gzip'`。
3. 解析器抛错 ⇒ 拒绝，不崩溃（要有专门用例）。
4. tar 流式读取用 `'entry'` 事件 + 显式 settle-once + 销毁上游。
5. 加密读取器**必须校验块序号与位置一致**，并有一个「调换两条记录必须被拒」的用例。
6. 内存上界断言用未完成字节数，不用 RSS。

---

## 6. 上传路径预检（P1 Task 1 回填，2026-10-05）

**探针**：`apps/api/.probe-t1/`（一次性，验完即删；脚本副本 `.superpowers/sdd/2026-10-05-p1-asset-artifact/evidence/t1-probe-*.mjs`，
**必须在 `apps/api/` 下运行**——`@nestjs/*` 要从 `apps/api/node_modules` 解析）。
**输出**：同目录 `t1-probe-*.txt`（三个探针 + 一个事件序列探针）。

### 6.1 multipart 接入的真实形态（`t1-probe-multipart.txt` / `t1-probe-memory.txt`）

| 问题 | 实测 |
|---|---|
| `FileInterceptor('file')` 默认（multer `memoryStorage`）| handler 拿到的 `file.buffer.length` **等于整份文件**（16 MiB 上传 ⇒ 16,777,216）；`arrayBuffers` 峰值增量是 body 的 **1.49–2.00 倍**。1 GB 上传在这条路径上不可能 |
| 自定义 storage engine | `_handleFile(req, file, cb)` 拿到 busboy 的 part 流 `file.stream`；engine 在客户端**发出后 44ms** 就收到第一块（此时客户端仍在发送），落盘字节数 = 文件字节数 |
| 未完成字节数（已发出 − 已落盘）峰值 | 1 MiB / 4 MiB / 16 MiB 三种输入分别为 129,940 / 0 / 0 字节 —— **不随输入增长**（`arrayBuffers` 读数受 GC 时机影响，同一探针里给出 1.000 / 0.937 / 0.016 三档，**不可用作判据**；验收口径必须是未完成字节数） |
| 有没有临时文件 | 全程只有目标对象一个文件（探针直接在 engine 的 `_handleFile` 里落盘，没有中间文件） |

**结论**：`memoryStorage` 会整份缓冲 ⇒ **不能**用它做 1 GB 上传；自定义 storage engine 是可用且正确的形态，**不需要自己解析 multipart**。

### 6.2 硬性大小上限（`t1-probe-cap.txt` / `t1-probe-cap-sequence.txt`）

| 问题 | 实测 |
|---|---|
| 触发的是哪种错误 | `MulterError: LIMIT_FILE_SIZE`（`limits.fileSize`） |
| 能不能映射成 413 | **能**：Nest `FileInterceptor` 的 `transformException` 把它翻成 `PayloadTooLargeException`，实测响应 `{"statusCode":413,...}`；**handler 不被调用** |
| 超限时引擎收到多少字节 | 恰好 `limit + 1` 字节（multer 给 busboy 传的是 `fileSize + 1`），且引擎回调**报告成功** —— 盘上是一份**被截断的对象** |
| 谁负责清理 | multer **会**调 `_removeFile`（带上引擎返回的键）；探针里把 `_removeFile` 写成空操作 ⇒ **残留**（`residue=["obj-0.bin"]`）。引擎自己报错时 multer **不再**调 `_removeFile`（事件序列探针实测），清理责任回到写入端 |
| 报错前是否读完请求体 | **是**。413 到达客户端时，客户端已确认写出**全部** 524,422 字节（`done(err)` 里先 `drainStream(req)` + `req.resume()` 再 `next(err)`，为避免 EPIPE） |
| 只留存储层上限（去掉 `limits.fileSize`） | 客户端拿到的是 **500**，不是 413：存储层中止会 destroy 上游 part 流，`process.nextTick` 上的流错误先于 promise 链到达 multer，`errorOccured` 已被置位，后续的 `HttpException` 被忽略 ⇒ **「把 ArtifactTooLargeError 翻成 413」是一段不可达代码**（Task 1 写了又删，变异探针 IMP2a/IMP2b 为证） |

### 6.3 busboy 自解析（**未取得可复现测量**，据实记载）

`busboy@1.6.0` 的 API 与 §6.1 相符（`Busboy({ headers, limits })`、`'file'`/`'limit'` 事件），
自解析**机制上**可以避免 6.2 的 drain（自己决定何时响应、何时停止读入）。
探针 `t1-probe-busboy-vs-multer.mjs` 的 multer 对照组复现了 drain（524,422 / 524,422），
但 busboy 组在服务器提前结束连接时**反复卡住**（客户端 `ECONNRESET` / 响应未达，探针超时），
**没有拿到可复现的数字**。因此本计划**不**以「自解析能省带宽」为依据；要采用它必须先补一个能稳定跑完的探针。

### 6.4 由预检得出的、必须写进实现的约束（Task 1 已落地）

1. 上传走**自定义 storage engine** + `putStream`（边收边写），**绝不** `memoryStorage`、**绝不**临时文件（C21 结构性成立）。
2. HTTP 层 `limits.fileSize` 与存储层 `maxBytes` 取**同一个**配置值；413 只能由 HTTP 层产生。
3. 超限/中止**两条清理路径都要实现**（写入端自己删 + `_removeFile` 按键删），「无残留」不得依赖任何一条单独成立。
4. `limits.fileSize` 的**代价是带宽**：超限上传仍会被完整读入（6.2 第 5 行）。真正的第一层限制在 Nginx（§3.1），应用层这道只保证「不落库、不残留」。
5. **P0 骨架的一个缺口（Task 1 暴露并修复）**：`packages/shared` 当时只导出 `./src/index.ts`，Node 22 的类型剥离会加载它、却解析不了其中的 `./ids.js` ⇒ 任何**构建产物**里的 `import '@vca/shared'` 都让进程崩在 `ERR_MODULE_NOT_FOUND`（实测：`tests/unit/bootstrap.test.ts` 的子进程用例）。修法：shared 补 `build`，exports 改成 `types/node/default` 三档（与 `apps/api` 同款），`apps/api` 的 build 先构建 shared。**P1 后续任务凡在运行期用到 shared 的值，都依赖这一步。**
