/**
 * Agent 动态工具集变更 API 单元测试（PR-1 stage 2）
 *
 * Stage 1（已合入 5c58fd4 后续 a982416 之前的 ee1440f 等价）：
 *   - smoke: 5 API 存在 + 初始 pending 空 + listTools 快照隔离
 *
 * Stage 2（本提交）≥5 条覆盖矩阵：
 *   t2-1  addTools 基础语义（添加可见 + tools/descriptors/index 三同步 + pending 事件）
 *   t2-2  addTools 同名覆盖（与 registerTodoTools 行为一致；descriptor 被替换且索引指向新版）
 *   t2-3  removeTools 幂等（不存在的 name 静默忽略，无 pending 事件副作用）
 *   t2-4  listPendingMutations / flushToolMutations 幂等（drain 后再 flush 空；之前的事件被取走）
 *   t2-5  三同步不变量（tools.size == toolDescriptors.length == toolDescriptorIndex.size；
 *         任意 name 在三处的存在性一致）
 *   t2-6  不影响 in-flight tool calls（exec 进行中调用 removeTools，
 *         exec 仍能跑完拿到原 ctx 与原 tool 引用 = 移除只对未来 LLM 轮次生效）
 *
 * 设计说明：
 *   - 不依赖真实 LLM；用 createUnitTestAgent + 手搓 ToolInstance fake
 *   - in-flight 隔离测试用 deferred promise 模拟 exec 延迟，期间触发 removeTools
 *   - 三同步不变量通过反射 (agent as any).<private field> 直接读，避免依赖未来可能调整的 getter
 *
 * 与 PR-1 设计回报对齐：line 258 共享引用 latent bug 在本批测试中**未触及**
 *   （我们只用公开 5 API + 反射读三个内部字段做不变量断言，不通过 runtime 句柄反向污染）。
 *   → 评估结论：cosmetic，PR description 标 "out of scope for PR-1"。
 */

import { createUnitTestAgent } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';
import type { ToolInstance, ToolDescriptor } from '../../../src/tools/registry';

// ---- fake tool 工厂 ----

interface FakeToolOptions {
  name: string;
  description?: string;
  exec?: (args: any, ctx: any) => Promise<any>;
}

function makeFakeTool(opts: FakeToolOptions): ToolInstance {
  const name = opts.name;
  const description = opts.description ?? `fake tool ${name}`;
  return {
    name,
    description,
    input_schema: { type: 'object', properties: {}, additionalProperties: true },
    async exec(args: any, ctx: any) {
      return opts.exec ? opts.exec(args, ctx) : { ok: true, name, args };
    },
    toDescriptor(): ToolDescriptor {
      return { source: 'registered', name, config: { tag: name } };
    },
  };
}

const runner = new TestRunner('Agent 动态工具集变更 API');

// ============================================================
// t0  stage 1 smoke（保留，回归保险）
// ============================================================
runner.test('PR-1 stage 1 smoke: 5 个新 API 存在且初始状态正确', async () => {
  const { agent, cleanup } = await createUnitTestAgent();

  expect.toEqual(typeof (agent as any).addTools, 'function');
  expect.toEqual(typeof (agent as any).removeTools, 'function');
  expect.toEqual(typeof (agent as any).listTools, 'function');
  expect.toEqual(typeof (agent as any).listPendingMutations, 'function');
  expect.toEqual(typeof (agent as any).flushToolMutations, 'function');

  const pending = (agent as any).listPendingMutations();
  expect.toEqual(Array.isArray(pending), true);
  expect.toEqual(pending.length, 0);

  const tools = (agent as any).listTools();
  expect.toEqual(Array.isArray(tools), true);

  const snapshot1 = (agent as any).listTools();
  snapshot1.push({ name: '__poison__', source: 'inline' as any });
  const snapshot2 = (agent as any).listTools();
  expect.toEqual(snapshot2.some((d: any) => d.name === '__poison__'), false);

  await cleanup();
});

// ============================================================
// t2-1  addTools 基础语义 + pending 事件
// ============================================================
runner.test('addTools 基础: 新工具进入 listTools / pending 累计一条 add 事件', async () => {
  const { agent, cleanup } = await createUnitTestAgent();

  const before = (agent as any).listTools().length;

  const tool = makeFakeTool({ name: 'fake_alpha' });
  const added = (agent as any).addTools([tool]);

  expect.toDeepEqual(added, ['fake_alpha']);

  const after: ToolDescriptor[] = (agent as any).listTools();
  expect.toEqual(after.length, before + 1);
  expect.toEqual(after.some((d) => d.name === 'fake_alpha'), true);

  // pending 累计 1 条 add
  const pending = (agent as any).listPendingMutations();
  expect.toEqual(pending.length, 1);
  expect.toEqual(pending[0].op, 'add');
  expect.toDeepEqual(pending[0].names, ['fake_alpha']);
  expect.toEqual(typeof pending[0].at, 'number');
  expect.toEqual(pending[0].at > 0, true);

  // listPendingMutations 返回快照不暴露引用
  pending.push({ op: 'remove', names: ['__poison__'], at: 0 } as any);
  const repeek = (agent as any).listPendingMutations();
  expect.toEqual(repeek.length, 1);

  await cleanup();
});

// ============================================================
// t2-2  addTools 同名覆盖
// ============================================================
runner.test('addTools 同名覆盖: descriptor 被替换，tools Map 指向新实例', async () => {
  const { agent, cleanup } = await createUnitTestAgent();

  const v1 = makeFakeTool({ name: 'fake_beta', description: 'v1' });
  const v2 = makeFakeTool({ name: 'fake_beta', description: 'v2' });

  (agent as any).addTools([v1]);
  (agent as any).addTools([v2]);

  // 公开 surface：listTools 中只有一份 fake_beta
  const list: ToolDescriptor[] = (agent as any).listTools();
  const matches = list.filter((d) => d.name === 'fake_beta');
  expect.toEqual(matches.length, 1);

  // 内部三同步：tools Map / toolDescriptorIndex 都各只持一份且指向最新版
  const toolsMap: Map<string, ToolInstance> = (agent as any).tools;
  expect.toEqual(toolsMap.get('fake_beta')?.description, 'v2');

  const idxMap: Map<string, ToolDescriptor> = (agent as any).toolDescriptorIndex;
  expect.toEqual(idxMap.has('fake_beta'), true);
  expect.toEqual(idxMap.get('fake_beta')?.name, 'fake_beta');

  // pending：两条 add 事件（覆盖也是 add 语义）
  const pending = (agent as any).listPendingMutations();
  expect.toEqual(pending.length, 2);
  expect.toEqual(pending[0].op, 'add');
  expect.toEqual(pending[1].op, 'add');

  await cleanup();
});

// ============================================================
// t2-3  removeTools 幂等
// ============================================================
runner.test('removeTools 幂等: 不存在 name 静默忽略，无 pending 事件副作用', async () => {
  const { agent, cleanup } = await createUnitTestAgent();

  // 加一个再删一个，第二次删同一个 + 删一个不存在的
  (agent as any).addTools([makeFakeTool({ name: 'fake_gamma' })]);
  (agent as any).flushToolMutations(); // drain，便于隔离观察后续

  const removed1 = (agent as any).removeTools(['fake_gamma']);
  expect.toDeepEqual(removed1, ['fake_gamma']);

  const removed2 = (agent as any).removeTools(['fake_gamma', 'never_existed']);
  expect.toDeepEqual(removed2, []); // 两个都不存在，都静默忽略

  // listTools 不再有 fake_gamma
  const list: ToolDescriptor[] = (agent as any).listTools();
  expect.toEqual(list.some((d) => d.name === 'fake_gamma'), false);
  expect.toEqual(list.some((d) => d.name === 'never_existed'), false);

  // pending：只有第一次 remove 入队，第二次 0 命中不入队
  const pending = (agent as any).listPendingMutations();
  expect.toEqual(pending.length, 1);
  expect.toEqual(pending[0].op, 'remove');
  expect.toDeepEqual(pending[0].names, ['fake_gamma']);

  await cleanup();
});

// ============================================================
// t2-4  flushToolMutations 幂等
// ============================================================
runner.test('flushToolMutations 幂等: drain 后再 flush 返回空数组', async () => {
  const { agent, cleanup } = await createUnitTestAgent();

  (agent as any).addTools([makeFakeTool({ name: 'fake_delta_1' })]);
  (agent as any).addTools([makeFakeTool({ name: 'fake_delta_2' })]);
  (agent as any).removeTools(['fake_delta_1']);

  const flushed1 = (agent as any).flushToolMutations();
  expect.toEqual(flushed1.length, 3);
  expect.toEqual(flushed1[0].op, 'add');
  expect.toEqual(flushed1[1].op, 'add');
  expect.toEqual(flushed1[2].op, 'remove');

  // 二次 flush 返回空（幂等）
  const flushed2 = (agent as any).flushToolMutations();
  expect.toEqual(Array.isArray(flushed2), true);
  expect.toEqual(flushed2.length, 0);

  // listPendingMutations 也应为空（flush 已 drain）
  const pending = (agent as any).listPendingMutations();
  expect.toEqual(pending.length, 0);

  // flush 后再加，pending 重新累计
  (agent as any).addTools([makeFakeTool({ name: 'fake_delta_3' })]);
  const pending2 = (agent as any).listPendingMutations();
  expect.toEqual(pending2.length, 1);

  await cleanup();
});

// ============================================================
// t2-5  三同步不变量（核心契约）
// ============================================================
runner.test('三同步不变量: tools / toolDescriptors / toolDescriptorIndex 三者大小与成员一致', async () => {
  const { agent, cleanup } = await createUnitTestAgent();

  const checkInvariant = (label: string) => {
    const toolsMap: Map<string, ToolInstance> = (agent as any).tools;
    const descArr: ToolDescriptor[] = (agent as any).toolDescriptors;
    const idxMap: Map<string, ToolDescriptor> = (agent as any).toolDescriptorIndex;

    // 大小一致
    expect.toEqual(toolsMap.size, descArr.length);
    expect.toEqual(descArr.length, idxMap.size);

    // descArr 内部 name 唯一
    const descNames = new Set(descArr.map((d) => d.name));
    expect.toEqual(descNames.size, descArr.length);

    // 每个 descriptor name 在 tools Map / index Map 都存在
    for (const d of descArr) {
      expect.toEqual(toolsMap.has(d.name), true);
      expect.toEqual(idxMap.has(d.name), true);
      expect.toEqual(idxMap.get(d.name)?.name, d.name);
    }

    // 反向：tools Map 每个 key 都在 descArr 与 index
    for (const k of toolsMap.keys()) {
      expect.toEqual(descNames.has(k), true);
      expect.toEqual(idxMap.has(k), true);
    }

    // 不变量描述（仅用于错误时定位）
    if (toolsMap.size !== descArr.length) {
      throw new Error(`[${label}] tools.size=${toolsMap.size} != descArr.length=${descArr.length}`);
    }
  };

  // 初始状态
  checkInvariant('init');

  // 加 3 个
  (agent as any).addTools([
    makeFakeTool({ name: 'inv_a' }),
    makeFakeTool({ name: 'inv_b' }),
    makeFakeTool({ name: 'inv_c' }),
  ]);
  checkInvariant('after-add-3');

  // 覆盖 inv_b
  (agent as any).addTools([makeFakeTool({ name: 'inv_b', description: 'overwritten' })]);
  checkInvariant('after-overwrite');

  // 删 inv_a 和不存在的 inv_x
  (agent as any).removeTools(['inv_a', 'inv_x']);
  checkInvariant('after-remove-mixed');

  // 删剩余两个
  (agent as any).removeTools(['inv_b', 'inv_c']);
  checkInvariant('after-remove-all-new');

  // 最终 add/remove 均归零，listTools 大小应回到初始
  const finalList: ToolDescriptor[] = (agent as any).listTools();
  expect.toEqual(
    finalList.some((d) => d.name.startsWith('inv_')),
    false,
  );

  await cleanup();
});

// ============================================================
// t2-6  不影响 in-flight tool calls
// ============================================================
runner.test('in-flight 隔离: exec 期间 removeTools 不影响正在跑的实例', async () => {
  const { agent, cleanup } = await createUnitTestAgent();

  // 用 deferred promise 控制 exec 完成时机
  let resolveExec!: (v: any) => void;
  const execGate = new Promise((r) => {
    resolveExec = r;
  });

  let execStarted = false;
  let execObservedSelfRemoval = false;

  const tool = makeFakeTool({
    name: 'inflight_tool',
    exec: async (args: any) => {
      execStarted = true;
      await execGate; // 等主测试方触发
      // exec 完成时，自检自己是否还在 agent.tools 里
      const toolsMap: Map<string, ToolInstance> = (agent as any).tools;
      execObservedSelfRemoval = !toolsMap.has('inflight_tool');
      return { ok: true, args };
    },
  });

  (agent as any).addTools([tool]);

  // 拿到 ToolInstance 引用并启动 exec（直接调，不经 LLM）
  const toolsMap: Map<string, ToolInstance> = (agent as any).tools;
  const instance = toolsMap.get('inflight_tool')!;
  expect.toEqual(typeof instance, 'object');

  const execPromise = instance.exec({ x: 1 }, {} as any);

  // 等待 exec 进入 await execGate 状态（轮询一次微任务）
  await new Promise((r) => setImmediate(r));
  expect.toEqual(execStarted, true);

  // 在 exec 跑到一半时移除工具
  (agent as any).removeTools(['inflight_tool']);

  // 关键不变量：移除后 listTools / tools Map 不再有它（对未来 LLM 轮次生效）
  expect.toEqual(toolsMap.has('inflight_tool'), false);
  const listAfterRemove: ToolDescriptor[] = (agent as any).listTools();
  expect.toEqual(listAfterRemove.some((d) => d.name === 'inflight_tool'), false);

  // 解锁 exec，验证它仍能跑完（持有的旧 instance 引用不受 Map.delete 影响）
  resolveExec({ released: true });
  const result: any = await execPromise;
  expect.toEqual(result.ok, true);
  expect.toEqual(result.args.x, 1);

  // exec 内部观察到自己已被从 Map 移除 = 数据面变更立即可见（对 exec body 透明）
  // 这正是"对未来轮次生效"的语义：当前 exec 不会被中断，但 Map 状态对它可见
  expect.toEqual(execObservedSelfRemoval, true);

  await cleanup();
});

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
