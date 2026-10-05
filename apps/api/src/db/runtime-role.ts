/**
 * **运行期数据库角色检查**（最终评审 C-2）。
 *
 * ## 它补的是什么洞：不变式 #5 此前建立在一个没人验证过的环境变量上
 *
 * append-only 之所以在数据库层成立，靠的是「运行期角色 `app_user` 与表属主 `vca_owner`
 * 是**两个**角色」，以及 `apply-grants.sql` 里那条 `REVOKE UPDATE, DELETE`（不变式 #5 / C7）。
 * 而应用侧把 `DATABASE_URL` **原样**交给 driver adapter——**没有任何地方检查过这条连接
 * 连上的到底是谁**：
 * - CI 的权限断言查的是 `app_user` **这个角色**的授权，不是应用实际用的那条连接；
 * - `tests/helpers/env.ts` 的 `DATABASE_URL` 是一个**从不连接**的夹具 URL；
 * - 认证管线用例整个 mock 掉了 Prisma。
 *
 * 后果很具体：任何一次部署把 `DATABASE_URL` 指成属主（把 `MIGRATE_DATABASE_URL` 复制粘贴
 * 过来——两个变量都在 `.env.example` 里，这是最自然的一种失误），**append-only 的 REVOKE
 * 就重新变成空操作**（属主永远保有全部权限），而这正是 Task 3 存在的理由、
 * 也是设计文档 §8.6 点名的「最大的纸面与实现落差」。此时**所有测试仍然全绿**。
 *
 * 这个模块把那条「纪律」变成**启动期拒绝服务**：连上的角色若能改动审计表，进程就不启动。
 *
 * ## 判据（两条，各自覆盖一类失误）
 *
 * 1. **`has_table_privilege(current_user, 'audit.audit_logs', 'UPDATE' | 'DELETE')`**——
 *    这是「审计轨迹可被改写」的**精确**条件：它同时覆盖表属主（属主永远保有全部权限，
 *    与 `REVOKE` 无关，见 `infra/db/roles.sql` 的实测记载）与任何被误授 UPDATE/DELETE 的角色；
 * 2. **角色本身是 superuser / `BYPASSRLS`**——这类角色能改任何东西（也能事后把权限授回来），
 *    因此即便此刻表还不存在也拒绝：它使第 1 条在将来失去意义。
 *
 * ## 边界（据实说明，别当成比它更强的保证）
 *
 * - 它查的是**连接的身份与权限**，不是「审计表将来会不会被改」：`ALTER TABLE` 之类的
 *   结构改动属于迁移（属主）的职责，运行期角色本就不该有。
 * - **连不上库时不启动失败**（只记一行 warn 并返回 `unverifiable`）：本应用按设计允许
 *   「先起来、库稍后可用」（`PrismaService.onModuleInit` 因此刻意不做探活），
 *   而现有的引导期用例（端口被占的子进程用例、真实引导用例）都跑在**没有数据库**的环境里，
 *   把「连不上」变成拒绝启动会改掉那条既有语义。方向仍是安全的：库连不上时应用什么也做不了，
 *   而**一旦连上就一定会被检查**——失误的部署（指向属主）在能服务任何请求之前就已经退出。
 * - 审计表不存在时同样退化成 `unverifiable`（迁移可能还没跑）；但 superuser 那一支照旧拒绝。
 */

/** 检查用到的连接面：只声明 `$queryRaw` 一个方法，测试因此可以注入一个最小替身。 */
export interface RoleQueryRunner {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** 一次查询的返回形状（列名与下面的 SQL 一一对应）。 */
interface RuntimeRoleRow {
  role: string;
  role_is_superuser: boolean;
  role_bypasses_rls: boolean;
  audit_table_missing: boolean;
  can_update_audit: boolean | null;
  can_delete_audit: boolean | null;
  audit_table_owner: string | null;
}

/** 检查结论。「无法完成检查」与「通过」是两件事，必须能区分（否则降级会被读成合格）。 */
export type RuntimeRoleVerdict =
  | { status: 'ok'; role: string }
  | { status: 'unverifiable'; detail: string };

/** 检查的时限：连接被黑洞时不能把启动卡住（`pg` 默认没有连接超时）。 */
export const ROLE_CHECK_TIMEOUT_MS = 5_000;

/** 检查不通过时抛出的错误（类型可辨识，便于用例与调用方区分于连接故障）。 */
export class RuntimeDbRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeDbRoleError';
  }
}

/**
 * 一条 SQL 拿到全部判据。
 *
 * 为什么用 `to_regclass(...) IS NULL` 守卫那两个 `has_table_privilege` 调用：
 * 表不存在时 `has_table_privilege` 会**报错**（关系不存在），而「迁移还没跑」不该让
 * 应用起不来（见文件头的边界说明）。`to_regclass` 对不存在的名字返回 NULL 而不抛。
 *
 * 写成模板标签**调用**（而不是把 SQL 存成字符串再插值）：Prisma 的 `$queryRaw` 是标签模板，
 * 插值进去的东西会变成**绑定参数**（`$1`），SQL 文本则留在模板字面量里——把整条查询插值进去，
 * 执行的就会是一段没有 SQL 的语句（`SELECT $1` 之类），而不是这条查询。
 */
function queryRuntimeRole(client: RoleQueryRunner): Promise<RuntimeRoleRow[]> {
  return client.$queryRaw<RuntimeRoleRow[]>`
    SELECT
      current_user::text AS role,
      r.rolsuper AS role_is_superuser,
      r.rolbypassrls AS role_bypasses_rls,
      to_regclass('audit.audit_logs') IS NULL AS audit_table_missing,
      CASE WHEN to_regclass('audit.audit_logs') IS NULL THEN NULL
           ELSE has_table_privilege(current_user, 'audit.audit_logs', 'UPDATE') END AS can_update_audit,
      CASE WHEN to_regclass('audit.audit_logs') IS NULL THEN NULL
           ELSE has_table_privilege(current_user, 'audit.audit_logs', 'DELETE') END AS can_delete_audit,
      (SELECT pg_get_userbyid(c.relowner)::text FROM pg_class c
        WHERE c.oid = to_regclass('audit.audit_logs')) AS audit_table_owner
    FROM pg_roles r
    WHERE r.rolname = current_user
  `;
}

/**
 * 把任意抛出值收敛成一句**不会再次抛出**的描述。
 *
 * 与 `SessionMiddleware.describeVerificationFailure` 同一条纪律（只做 `typeof` 与受保护的
 * 属性读取）：这段代码跑在 catch 里，而它要描述的是一个不可信的值。**刻意不 import 那一份**：
 * 它是功能模块（`modules/auth`）的内部实现，平台层反过来依赖它会破坏依赖方向（§3.3 第 2 条）。
 */
function describeThrown(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type !== 'object' && type !== 'function') return type;
  try {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message.slice(0, 200);
  } catch {
    // 读 message 自己抛了：退化成类型名
  }
  return type;
}

/** 「无法完成检查」时的上报口（生产接 pino；检查本身不抛出）。 */
export type UnverifiableReporter = (fields: Record<string, unknown>, message: string) => void;

/**
 * 调用上报口，并保证**它自己抛错也不会改变引导的方向**。
 *
 * 为什么必须兜住：调用方传进来的通常是 `app.get(PinoLogger).warn(...)`，而它在极早期
 * （日志器还没装好、或应用是个不完整的替身）确实可能抛。那种抛出会从「检查无法完成」
 * 变成「引导失败」，把一条 warn 升级成一次拒绝启动——那与「日志不该改变控制流」
 * 这条既有纪律相反（同一条纪律见 `logger.module.ts` 的降级路径与 I-7）。
 */
function reportUnverifiable(
  reporter: UnverifiableReporter | undefined,
  fields: Record<string, unknown>,
  message: string,
): void {
  if (!reporter) return;
  try {
    reporter(fields, message);
  } catch {
    // 记录失败的检查结果，本身不能再抛
  }
}

/**
 * 在**引导期**断言「这条数据库连接的身份是允许的运行期角色」。
 *
 * 通过时返回 `{ status: 'ok' }`；角色不对时抛 {@link RuntimeDbRoleError}（调用方据此拒绝启动）；
 * 无法完成检查时调用 `onUnverifiable` 并返回 `{ status: 'unverifiable' }`（见文件头的边界）。
 */
export async function assertRuntimeDbRole(
  client: RoleQueryRunner,
  options: { timeoutMs?: number; onUnverifiable?: UnverifiableReporter } = {},
): Promise<RuntimeRoleVerdict> {
  const { timeoutMs = ROLE_CHECK_TIMEOUT_MS, onUnverifiable } = options;

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  let rows: RuntimeRoleRow[] | 'timeout';
  try {
    rows = await Promise.race([queryRuntimeRole(client), timedOut]);
  } catch (err: unknown) {
    const detail = `${describeThrown(err)}`;
    reportUnverifiable(
      onUnverifiable,
      { check: 'runtime-db-role', detail },
      `运行期数据库角色检查**未能完成**（连接不可用，无法断言审计表是否只读）：${detail}`,
    );
    return { status: 'unverifiable', detail };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (rows === 'timeout') {
    const detail = `超过 ${timeoutMs}ms 未返回（连接被黑洞？）`;
    reportUnverifiable(
      onUnverifiable,
      { check: 'runtime-db-role', detail },
      `运行期数据库角色检查**未能完成**（查询超时，无法断言审计表是否只读）：${detail}`,
    );
    return { status: 'unverifiable', detail };
  }

  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || typeof row.role !== 'string') {
    // 形状不对是**硬失败**：这时我们连自己连上了谁都不知道，不能猜。
    throw new RuntimeDbRoleError(
      '运行期数据库角色检查失败：`SELECT current_user …` 返回了意外形状，' +
        `无法判定连接身份（实际：${JSON.stringify(rows)}）。`,
    );
  }

  const privileged: string[] = [];
  if (row.role_is_superuser) privileged.push('SUPERUSER');
  if (row.role_bypasses_rls) privileged.push('BYPASSRLS');
  if (row.can_update_audit || row.can_delete_audit) {
    const verbs = [row.can_update_audit ? 'UPDATE' : undefined, row.can_delete_audit ? 'DELETE' : undefined]
      .filter((verb): verb is string => verb !== undefined)
      .join('/');
    privileged.push(`对 audit.audit_logs 具备 ${verbs} 权限`);
  }

  if (privileged.length > 0) {
    const owner = row.audit_table_owner ? `（该表的属主是「${row.audit_table_owner}」）` : '';
    throw new RuntimeDbRoleError(
      '运行期数据库角色检查未通过：当前连接的角色是「' +
        row.role +
        '」，' +
        privileged.join('、') +
        owner +
        '。\n' +
        '这意味着 append-only 的撤权（`REVOKE UPDATE, DELETE ON audit.audit_logs`，不变式 #5 / C7）' +
        '在这条连接上是**空操作**：属主与超级用户永远保有全部权限，审计轨迹因此可以被改写或删除。\n' +
        '请检查 **DATABASE_URL**：它必须指向最小权限的运行期角色（app_user），' +
        '绝不能是迁移属主（那是 MIGRATE_DATABASE_URL 的值）。\n' +
        '本进程拒绝启动：与其带着一条可被篡改的审计轨迹运行，不如不运行。',
    );
  }

  if (row.audit_table_missing) {
    const detail = 'audit.audit_logs 不存在（迁移还没跑？）';
    reportUnverifiable(
      onUnverifiable,
      { check: 'runtime-db-role', detail },
      `运行期数据库角色检查**未能完成**：${detail}——连接角色「${row.role}」不是特权角色，` +
        '但表级权限此刻无从断言；迁移之后应重新部署以让本次检查生效',
    );
    return { status: 'unverifiable', detail };
  }

  return { status: 'ok', role: row.role };
}
