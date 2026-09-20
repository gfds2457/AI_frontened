#!/usr/bin/env node
/**
 * 独立启动工具服务（开发/调试用）。
 *
 * 正常运行时工具服务由 app.js 随主程序一起拉起；这个入口用于单独调试 Python 侧，
 * 不必启动整个 TUI。启动后打印 TOOL_SERVER_PORT=<port>，方便脚本抓取。
 *
 * 用法：node src/server/start.js [port]     # 缺省 8799
 */
import process from 'node:process';
import { startToolServer } from './toolServer.js';

const port = Number(process.argv[2] || process.env.TOOL_SERVER_PORT || 8799);

const { port: actual, close } = await startToolServer(port);
console.log(`TOOL_SERVER_PORT=${actual}`);

const stop = async () => {
  await close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
