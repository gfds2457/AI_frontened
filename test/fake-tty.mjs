/**
 * 伪 TTY 预载模块（配合 node --import 使用），让 app.js 在无终端环境下走「真 TUI」路径。
 *
 * 为什么需要它：input.js 开头就判断 `process.stdin.isTTY`，为假时直接 requestExit →
 * shutdown → process.exit，什么都验证不到（`front < /dev/null` 立刻退出的原因）。
 * 这里把四项 TTY 特征补上即可 —— renderer 只读 columns/rows，不读 isTTY，
 * stdin 是管道时 isTTY/setRawMode 都可直接赋值。
 *
 * 用法：node --import ./test/fake-tty.mjs app.js
 */
process.stdin.isTTY = true;
process.stdin.setRawMode = () => {};
process.stdout.isTTY = true;
if (!process.stdout.columns) process.stdout.columns = 100;
if (!process.stdout.rows) process.stdout.rows = 30;
