/**
 * 实机验证脚本（需要真实终端，不能管道运行）：把真实的 TUI 输入控制器接一次真实的
 * select 工具，复现并验证用户报的故障 —— 「回答完一次 select，界面还在但打字没反应、Ctrl+C 也退不掉」。
 *
 * 用法：node test/tui-live-select.mjs
 * 步骤：1) 输入 select 回车 → 工具弹出选项浮层 → 回答 1 或 2
 *       2) 看 stdin.isPaused() 是否 false，然后随便打字：能看见字 = 交还成功
 *       3) Ctrl+C 优雅退出；再连按两次 Ctrl+C 应能强制退出
 */
import { createInput } from '../src/tui/input.js';
import { getTools, invokeTool, closeTools } from '../src/tools/manager.js';
import * as renderer from '../src/tui/renderer.js';

const input = createInput();

async function shutdown() {
  input.stop();
  renderer.teardown();
  await closeTools().catch(() => {});
  console.log('已退出。');
  process.exit(0);
}

input.start({
  onMessage: async (text) => {
    if (text.trim().toLowerCase() === 'select') {
      // getTools() 必须先跑一次，invokeTool 用的是它缓存的工具表
      await getTools();
      const r = await invokeTool('select', {
        question: '验证用：随便选一个',
        options: ['选项 A', '选项 B'],
      });
      console.log(`select 返回：${r.text}`);
      console.log(`stdin.isPaused() = ${process.stdin.isPaused()}   ← 必须是 false`);
      console.log('现在打字应当能上屏；Ctrl+C 当场退出，再连按两次应能强制退出。');
      return;
    }
    console.log(`收到消息：${text}（输入 select 回车可触发一次真实 select 工具）`);
  },
  onCommand: async (cmd) => {
    console.log(`收到指令：${cmd}（本验证脚本不处理指令，输入 select 或 Ctrl+C）`);
  },
  onExit: shutdown,
});
