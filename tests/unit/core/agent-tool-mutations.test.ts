/**
 * Agent 动态工具集变更 API 单元测试（PR-1 stage 1 占位）
 *
 * Stage 1：smoke - 仅验证 5 个新 API 存在 + 初始状态正确。
 * Stage 2（下午）：补 ≥5 条覆盖：
 *   - addTools 同名覆盖语义
 *   - removeTools 幂等（不存在的 name 静默忽略）
 *   - listTools 返回快照（修改返回值不影响内部）
 *   - listPendingMutations 累积顺序 + 不被 listTools 改变
 *   - flushToolMutations 清空 + 二次调用返回空（幂等）
 *   - 三同步一致性（tools / toolDescriptors / toolDescriptorIndex）
 *   - 不影响 in-flight tool calls（通过 mock tool 验证）
 */

import { createUnitTestAgent } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Agent 动态工具集变更 API');

runner
  .test('PR-1 stage 1 smoke: 5 个新 API 存在且初始状态正确', async () => {
    const { agent, cleanup } = await createUnitTestAgent();

    expect.toEqual(typeof (agent as any).addTools, 'function');
    expect.toEqual(typeof (agent as any).removeTools, 'function');
    expect.toEqual(typeof (agent as any).listTools, 'function');
    expect.toEqual(typeof (agent as any).listPendingMutations, 'function');
    expect.toEqual(typeof (agent as any).flushToolMutations, 'function');

    // 初始 pending mutations 应为空
    const pending = (agent as any).listPendingMutations();
    expect.toEqual(Array.isArray(pending), true);
    expect.toEqual(pending.length, 0);

    // listTools 返回数组（具体内容由模板决定，不在此约束）
    const tools = (agent as any).listTools();
    expect.toEqual(Array.isArray(tools), true);

    // listTools 返回快照而非引用：修改不污染内部
    const snapshot1 = (agent as any).listTools();
    snapshot1.push({ name: '__poison__', source: 'inline' as any });
    const snapshot2 = (agent as any).listTools();
    expect.toEqual(snapshot2.some((d: any) => d.name === '__poison__'), false);

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
