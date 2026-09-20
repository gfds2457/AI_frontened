/**
 * 输入控制器 —— 逐键输入的状态机。
 *
 * 四种模式（同一时刻仅一种）：
 *  - IDLE    普通文本编辑（支持左右移动光标、Home/End）
 *  - COMMAND 输入 `/` 后：按前缀过滤指令，↑/↓ 选择，Tab/回车执行，Esc 取消
 *  - FILE    输入 `@` 后：目录树浏览选文件，↑/↓ 选择，回车进目录/返回/选定，Esc 取消
 *  - DESIGN  输入 `#` 后：列出 .front/design 下所有图片（含 AI 生成的素材图），↑/↓ 选择，回车插入 #路径 标记，Esc 取消
 *
 * 触发键 `/ @ #` 不立即进模式：先当普通字符收下，30ms 内没有后续按键才弹浮层，
 * 这样拖拽/粘贴进来的整串路径（本身可能带 / @ #）不会被误当成触发键。
 * 路径的浅蓝框由 renderer 每次重画时按 pathToken 的识别结果套上 —— 与发送前读文件同一套规则。
 *
 * 通过 createInput(renderer) 创建，start({...}) 传入业务回调：
 *  - onCommand(text): 以 `/` 开头的整段（含 /help /exit 等）
 *  - onMessage(text): 普通文本消息
 *  - onExit():        退出程序（Ctrl+C / Ctrl+D）
 *
 * 提交前会 clear() 掉 UI 块让业务输出干净打印；处理完成后自动重画空输入行。
 * busy 期间忽略除退出外的所有按键。
 */
import { emitKeypressEvents } from 'node:readline';
import process from 'node:process';
import chalk from 'chalk';
import { filterCommands } from '../utils/command/commands.js';
import { listDir, joinRel, parentOf } from '../utils/fs/fileBrowser.js';
import { listDesignImages } from '../utils/input/image.js';
import { redraw, clear, showEmptyPrompt, termCols, row, commitInput, restoreCursor } from './renderer.js';

// 可变「当前模式」；单个应用实例只有一个输入控制器
let _mode = 'IDLE';

// 触发键（/ @ #）延迟进模式的等待毫秒数：拖拽/粘贴进来的路径是一整串字符同时到达，
// 先让触发键当普通字符收下，这么久内没有后续按键才确认是「单独按的」，再弹浮层。
// 这样粘贴内容里恰好带 / @ #（如 Git Bash 的 /e/xxx、含 @ 的用户目录）也不会误弹。
const TRIGGER_DELAY = 30;

// 有名字的控制键（方向、编辑、回车等），其余带 str 的按键视为可打印字符
const NAMED_KEYS = new Set([
  'return', 'enter', 'tab', 'backspace', 'escape', 'delete', 'insert',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
]);

export function createInput() {
  let cfg = { onCommand: null, onMessage: null, onExit: null };

  let started = false;
  let busy = false;
  let busyHinted = false; // busy 期间是否已提示过「处理中」（每轮只提示一次，避免刷屏）
  let stopped = false;

  // ---- IDLE 状态 ----
  let text = '';
  let caret = 0;
  // ---- COMMAND 状态 ----
  let cmdWord = '';
  let cmdSel = 0;
  // ---- FILE 状态 ----
  let pre = '';
  let fword = '';
  let post = '';
  let dir = ''; // 当前浏览的相对目录
  let dirCache = { dirs: [], files: [] }; // 当前目录的原始子项缓存
  let fsel = 0;
  // ---- DESIGN 状态 ----
  let dlist = []; // .front/design/AI-asset 下可选图片（相对 design 目录）
  let dword = ''; // 图片名过滤词
  let dsel = 0;
  // ---- 触发键延迟 ----
  let pendingTrigger = null; // { ch, pos, timer } 已落到文本里、等待确认的触发键

  /* ==================== 显示辅助 ==================== */

  function displayText() {
    if (mode() === 'COMMAND') return `/${cmdWord}`;
    if (mode() === 'FILE') return `${pre}@${fword}${post}`;
    if (mode() === 'DESIGN') return `${pre}#${dword}${post}`;
    return text;
  }
  function displayCaret() {
    if (mode() === 'COMMAND') return cmdWord.length + 1;
    if (mode() === 'FILE') return pre.length + fword.length + 1;
    if (mode() === 'DESIGN') return pre.length + dword.length + 1;
    return caret;
  }
  function mode() {
    return started ? _mode : 'IDLE';
  }

  function overlayLines() {
    const limit = termCols();
    const m = mode();
    if (m === 'COMMAND') return commandOverlay(limit);
    if (m === 'FILE') return fileOverlay(limit);
    if (m === 'DESIGN') return designOverlay(limit);
    return [];
  }

  function commandOverlay(limit) {
    const matched = filterCommands(cmdWord);
    if (cmdSel > matched.length - 1) cmdSel = Math.max(0, matched.length - 1);
    const maxRows = Math.max(1, (process.stdout.rows || 24) - 3);
    const lines = [];
    const shown = matched.slice(0, maxRows);
    shown.forEach((c, i) => {
      const sel = i === cmdSel;
      if (sel) {
        lines.push(row([[`  ${c.trigger}  ${c.desc}  `, chalk.inverse]], limit));
      } else {
        lines.push(
          row(
            [
              [`  ${c.trigger}`, chalk.cyan.bold],
              ['   ', null],
              [c.desc, chalk.gray],
            ],
            limit,
          ),
        );
      }
    });
    if (matched.length > maxRows) {
      lines.push(row([[`  … 还有 ${matched.length - maxRows} 条匹配`, chalk.gray]], limit));
    }
    if (matched.length === 0) {
      lines.push(row([['  （无匹配指令，回车将按未知指令处理）', chalk.gray]], limit));
    }
    return lines;
  }

  function fileOverlay(limit) {
    const entries = visibleEntries();
    if (fsel > entries.length - 1) fsel = Math.max(0, entries.length - 1);
    const maxRows = Math.max(3, (process.stdout.rows || 24) - 3);
    const lines = [];
    lines.push(row([[`  当前：${dir || '.'}`, chalk.gray]], limit));
    const shown = entries.slice(0, maxRows);
    shown.forEach((e, i) => {
      const sel = i === fsel;
      if (e.type === 'up') {
        lines.push(sel ? row([['  ↰ 上一级', chalk.inverse]], limit) : row([['  ↰ 上一级', chalk.gray]], limit));
      } else if (e.type === 'dir') {
        const style = sel ? chalk.inverse : chalk.cyan;
        lines.push(row([[`  ${e.name}/`, style]], limit));
      } else {
        lines.push(sel ? row([[`  ${e.name}`, chalk.inverse]], limit) : row([[`  ${e.name}`, null]], limit));
      }
    });
    if (entries.length === 0) lines.push(row([['  （当前目录无可选文件）', chalk.gray]], limit));
    if (entries.length > maxRows) {
      lines.push(row([[`  … 还有 ${entries.length - maxRows} 项`, chalk.gray]], limit));
    }
    return lines;
  }

  function designVisible() {
    return dlist.filter((p) => !dword || p.toLowerCase().includes(dword.toLowerCase()));
  }

  function designOverlay(limit) {
    const entries = designVisible();
    if (dsel > entries.length - 1) dsel = Math.max(0, entries.length - 1);
    const maxRows = Math.max(3, (process.stdout.rows || 24) - 3);
    // 列表标题需要更新路径引用
    const lines = [];
    lines.push(
      row([[`  .front/design 图片 ${dlist.length} 张：回车插入 / 空格保留 # / Esc 取消`, chalk.gray]], limit),
    );

    // 选中项跟着滚动窗口走，保证高亮行始终在屏上
    const start = Math.max(0, Math.min(dsel - Math.floor(maxRows / 2), entries.length - maxRows));
    entries.slice(start, start + maxRows).forEach((e, i) => {
      const sel = start + i === dsel;
      lines.push(sel ? row([[`  ${e}`, chalk.inverse]], limit) : row([[`  ${e}`, chalk.cyan]], limit));
    });

    if (entries.length === 0) {
      lines.push(row([['  （.front/design 目录下暂无可选图片）', chalk.gray]], limit));
    }
    if (entries.length > maxRows) {
      lines.push(row([[`  … 还有 ${entries.length - maxRows} 项`, chalk.gray]], limit));
    }
    return lines;
  }

  /* ==================== FILE 浏览状态 ==================== */

  function reloadDir() {
    dirCache = listDir(dir);
  }

  function visibleEntries() {
    const out = [];
    if (dir !== '') out.push({ type: 'up', name: '↰ 上一级' });
    for (const d of dirCache.dirs) if (!fword || d.startsWith(fword)) out.push({ type: 'dir', name: d });
    for (const f of dirCache.files) if (!fword || f.startsWith(fword)) out.push({ type: 'file', name: f });
    return out;
  }

  function selectEntry(entry) {
    if (entry.type === 'up') {
      dir = parentOf(dir);
      reloadDir();
      fword = '';
      fsel = 0;
      refresh();
    } else if (entry.type === 'dir') {
      dir = joinRel(dir, entry.name);
      reloadDir();
      fword = '';
      fsel = 0;
      refresh();
    } else {
      // 选定文件：插入 @相对路径 + 一个空格，回到普通输入
      const rel = joinRel(dir, entry.name);
      text = `${pre}@${rel} ${post}`;
      caret = pre.length + rel.length + 2;
      exitFileMode();
    }
  }

  function exitFileMode() {
    _mode = 'IDLE';
    pre = '';
    fword = '';
    post = '';
    dir = '';
    dirCache = { dirs: [], files: [] };
    fsel = 0;
    refresh();
  }

  function cancelFileMode() {
    // Esc：删除 @ 及其过滤词，保留前后文本
    text = pre + post;
    caret = pre.length;
    exitFileMode();
  }

  function enterFileMode() {
    pre = text.slice(0, caret);
    post = text.slice(caret);
    fword = '';
    dir = '';
    reloadDir();
    fsel = 0;
    _mode = 'FILE';
    refresh();
  }

  /* ==================== DESIGN 状态（# 选图） ==================== */

  function enterDesignMode() {
    pre = text.slice(0, caret);
    post = text.slice(caret);
    dword = '';
    dsel = 0;
    dlist = listDesignImages();
    _mode = 'DESIGN';
    refresh();
  }

  function exitDesignMode() {
    _mode = 'IDLE';
    pre = '';
    post = '';
    dword = '';
    dlist = [];
    dsel = 0;
    refresh();
  }

  function cancelDesignMode() {
    // Esc：丢弃刚输入的 # 及过滤词，保留前后文本
    text = pre + post;
    caret = pre.length;
    exitDesignMode();
  }

  /** 回车/Tab：把高亮图片以 #.front/design/<路径> 标记插到光标处，回到普通输入 */
  function designEnter() {
    const entries = designVisible();
    if (entries.length === 0) return;
    if (dsel > entries.length - 1) dsel = entries.length - 1;
    const token = `#.front/design/${entries[dsel]} `;
    text = pre + token + post;
    caret = pre.length + token.length;
    exitDesignMode();
  }

  function designBackspace() {
    if (dword.length > 0) {
      dword = dword.slice(0, -1);
      dsel = 0;
      refresh();
    } else {
      // 过滤词已空 -> 删除 # 本身
      cancelDesignMode();
    }
  }

  function designPrintable(str) {
    // 空格：不再继续选图，保留刚输入的 #过滤词 作为普通文本，回到 IDLE 继续打字
    if (str === ' ') {
      text = `${pre}#${dword} ${post}`;
      caret = pre.length + dword.length + 2;
      exitDesignMode();
      return;
    }
    dword += str;
    dsel = 0;
    refresh();
  }

  /* ==================== 触发键延迟（区分「手打」与「粘贴」） ==================== */

  /** 撤销等待中的触发键：把已落进文本的字符原样留下，按普通文本继续 */
  function dropTrigger() {
    if (!pendingTrigger) return;
    clearTimeout(pendingTrigger.timer);
    pendingTrigger = null;
  }

  /** 确认等待中的触发键：把字符从文本里退回，交给对应的浮层模式接管 */
  function flushTrigger() {
    if (!pendingTrigger) return;
    clearTimeout(pendingTrigger.timer);
    const { ch, pos } = pendingTrigger;
    pendingTrigger = null;
    text = text.slice(0, pos) + text.slice(pos + ch.length);
    caret = pos;
    if (ch === '/') enterCommandMode();
    else if (ch === '@') enterFileMode();
    else enterDesignMode();
  }

  /**
   * 触发键入口：先当作普通字符插入文本（这段时间显示与普通输入完全一致），
   * 延迟 TRIGGER_DELAY 毫秒确认没有后续按键后才真正进入浮层模式。
   */
  function triggerMode(ch) {
    // `/` 只在空输入行才是指令，否则就是路径里或正文里的普通斜杠
    if (ch === '/' && text !== '') {
      insertAt(ch);
      refresh();
      return;
    }
    insertAt(ch);
    const pos = caret - ch.length;
    pendingTrigger = {
      ch,
      pos,
      timer: setTimeout(() => {
        // 处理中/已退出时不再改界面：此时输入行已被业务清屏，重画会打断流式输出
        if (busy || stopped) dropTrigger();
        else flushTrigger();
      }, TRIGGER_DELAY),
    };
    refresh();
  }

  /* ==================== COMMAND 状态 ==================== */

  function enterCommandMode() {
    text = '';
    caret = 0;
    cmdWord = '';
    cmdSel = 0;
    _mode = 'COMMAND';
    refresh();
  }

  function cancelCommandMode() {
    // Esc / 只剩 / 时退格：丢弃整个命令输入，回到空输入行
    _mode = 'IDLE';
    cmdWord = '';
    cmdSel = 0;
    refresh();
  }

  /* ==================== 光标步进（兼容代理对/emoji） ==================== */

  function stepBack(s, idx) {
    if (idx <= 0) return idx;
    const code = s.charCodeAt(idx - 1);
    if (code >= 0xdc00 && code <= 0xdfff && idx - 2 >= 0) return idx - 2;
    return idx - 1;
  }
  function stepForward(s, idx) {
    if (idx >= s.length) return idx;
    const code = s.charCodeAt(idx);
    if (code >= 0xd800 && code <= 0xdbff && idx + 1 < s.length) return idx + 2;
    return idx + 1;
  }

  /* ==================== 文本编辑 ==================== */

  function insertAt(ch) {
    text = text.slice(0, caret) + ch + text.slice(caret);
    caret += ch.length;
  }

  function backspaceAt() {
    if (caret <= 0) return;
    const left = stepBack(text, caret);
    text = text.slice(0, left) + text.slice(caret);
    caret = left;
  }

  function resetState() {
    dropTrigger();
    text = '';
    caret = 0;
    cmdWord = '';
    cmdSel = 0;
    pre = '';
    fword = '';
    post = '';
    dir = '';
    dirCache = { dirs: [], files: [] };
    fsel = 0;
    dlist = [];
    dword = '';
    dsel = 0;
    _mode = 'IDLE';
  }

  /* ==================== 提交与执行业务 ==================== */

  function refresh() {
    redraw(displayText(), displayCaret(), overlayLines());
  }

  /**
   * stdin 兜底：按键全靠 stdin 流动时的 keypress 事件，一旦被别的模块 pause 掉，
   * 界面照常显示却打不了字、Ctrl+C 也退不掉（raw 模式下 Ctrl+C 不产生 SIGINT）。
   * 已知的坑是 readline.close()（confirm/select 用它读一行），已由
   * utils/input/lineInput.js 负责恢复；这里每轮处理结束再兜一次，杜绝任何漏网场景。
   */
  function ensureInputFlowing() {
    if (started && !stopped && process.stdin.isPaused()) process.stdin.resume();
  }

  async function runHandler(fn, echoText) {
    busy = true;
    busyHinted = false;
    // 把用户输入固化成一条会话记录，替代清屏（否则发送后内容就从终端消失）
    commitInput(echoText);
    resetState();
    try {
      await fn();
    } finally {
      busy = false;
      busyHinted = false;
      ensureInputFlowing();
      if (!stopped) showEmptyPrompt();
    }
  }

  function doSubmit() {
    const raw = displayText();
    if (!raw.trim()) {
      refresh();
      return;
    }
    if (raw.trim().startsWith('/')) {
      runHandler(() => cfg.onCommand(raw.trim()), raw.trim());
    } else {
      runHandler(() => cfg.onMessage(raw), raw);
    }
  }

  /** 在 COMMAND 模式中确认执行某条指令文本（含 /） */
  function runCommand(fullTrigger) {
    runHandler(() => cfg.onCommand(fullTrigger), fullTrigger);
  }

  function requestExit() {
    stopped = true;
    dropTrigger();
    clear();
    if (cfg.onExit) cfg.onExit();
  }

  /**
   * 第二次 Ctrl+C：优雅退出（存对话、关 MCP）卡住时直接强退，保证任何情况下都退得掉。
   * raw 模式下终端不会把 Ctrl+C 转成 SIGINT，app.js 的 SIGINT 兜底只在
   * 退出流程已把 raw 关掉之后才有效，所以按键这一层必须自己留一条硬退路。
   */
  function forceExit() {
    restoreCursor();
    process.stdout.write('\n' + chalk.gray('已强制退出（对话可能未保存）。') + '\n');
    process.exit(1);
  }

  /* ==================== FILE 模式处理 ==================== */

  function filePrintable(str) {
    // 空格：放弃继续选文件，保留已输入的 @word，回到普通输入继续打字
    if (str === ' ') {
      text = `${pre}@${fword}${post}`;
      caret = pre.length + fword.length + 1;
      // 追加空格
      text = text.slice(0, caret) + ' ' + text.slice(caret);
      caret += 1;
      exitFileMode();
      return;
    }
    fword += str;
    fsel = 0;
    refresh();
  }

  function fileEnter() {
    const entries = visibleEntries();
    if (entries.length === 0) return;
    if (fsel > entries.length - 1) fsel = entries.length - 1;
    selectEntry(entries[fsel]);
  }

  function fileBackspace() {
    if (fword.length > 0) {
      fword = fword.slice(0, -1);
      fsel = 0;
      refresh();
    } else {
      // 过滤词已空 -> 删除 @ 本身
      cancelFileMode();
    }
  }

  /* ==================== COMMAND 模式处理 ==================== */

  function commandPrintable(str) {
    // 空格：锁定当前匹配的指令，转回 IDLE 模式继续输入参数
    // 这样用户可以输入 /a:d 我的问题 这类「指令 + 参数」形式
    if (str === ' ') {
      const matched = filterCommands(cmdWord);
      if (matched.length > 0) {
        const pick = matched[cmdSel] || matched[0];
        text = `${pick.trigger} `;
        caret = text.length;
        _mode = 'IDLE';
        cmdWord = '';
        cmdSel = 0;
        refresh();
        return;
      }
    }
    cmdWord += str;
    cmdSel = 0;
    refresh();
  }

  function commandEnter() {
    const matched = filterCommands(cmdWord);
    if (matched.length > 0) {
      if (cmdSel > matched.length - 1) cmdSel = matched.length - 1;
      runCommand(matched[cmdSel].trigger);
    } else {
      // 无匹配时保持旧行为：交给 handleCommand，打印「未知命令」
      runCommand(`/${cmdWord}`);
    }
  }

  function commandBackspace() {
    if (cmdWord.length > 0) {
      cmdWord = cmdWord.slice(0, -1);
      cmdSel = 0;
      refresh();
    } else {
      cancelCommandMode();
    }
  }

  /* ==================== 按键分发 ==================== */

  function handleKey(str, key) {
    const k = key || {};
    if (k.ctrl && (k.name === 'c' || k.name === 'd')) {
      // stopped 为真说明优雅退出已在进行中（可能正卡在存对话/关 MCP），再按一次直接强退
      if (stopped) forceExit();
      else requestExit();
      return;
    }
    if (busy) {
      // 处理期间不接收输入，但给一次可见提示，避免用户误以为终端「无法输入」
      if (!busyHinted) {
        busyHinted = true;
        process.stdout.write(
          '\r\x1b[2K' + chalk.gray('（正在处理中，完成后即可继续输入；连按两次 Ctrl+C 可强制退出）') + '\n',
        );
      }
      return;
    }
    if (stopped) return;

    // 等待中的触发键：又来一个可打印字符说明这是粘贴/快速输入，撤销触发当普通文本；
    // 来的是控制键则先落实触发（比如 `@` 后马上回车，仍按原逻辑弹浮层）
    if (pendingTrigger) {
      if (str && !k.ctrl && !k.meta && !NAMED_KEYS.has(k.name)) dropTrigger();
      else flushTrigger();
    }

    const m = mode();

    // 控制性按键（方向/编辑键）
    switch (k.name) {
      case 'return':
      case 'enter':
        if (m === 'COMMAND') return commandEnter();
        if (m === 'FILE') return fileEnter();
        if (m === 'DESIGN') return designEnter();
        return doSubmit();
      case 'tab':
        if (m === 'COMMAND') return commandEnter();
        if (m === 'FILE') return fileEnter();
        if (m === 'DESIGN') return designEnter();
        return; // IDLE 下忽略
      case 'backspace':
        if (m === 'COMMAND') return commandBackspace();
        if (m === 'FILE') return fileBackspace();
        if (m === 'DESIGN') return designBackspace();
        backspaceAt();
        refresh();
        return;
      case 'escape':
        if (m === 'COMMAND') return cancelCommandMode();
        if (m === 'FILE') return cancelFileMode();
        if (m === 'DESIGN') return cancelDesignMode();
        return;
      case 'up':
        if (m === 'COMMAND') {
          const matched = filterCommands(cmdWord);
          cmdSel = matched.length === 0 ? 0 : Math.max(0, cmdSel - 1);
          refresh();
        } else if (m === 'FILE') {
          fsel = Math.max(0, fsel - 1);
          refresh();
        } else if (m === 'DESIGN') {
          dsel = Math.max(0, dsel - 1);
          refresh();
        }
        return;
      case 'down':
        if (m === 'COMMAND') {
          const matched = filterCommands(cmdWord);
          cmdSel = matched.length === 0 ? 0 : Math.min(matched.length - 1, cmdSel + 1);
          refresh();
        } else if (m === 'FILE') {
          const entries = visibleEntries();
          fsel = entries.length === 0 ? 0 : Math.min(entries.length - 1, fsel + 1);
          refresh();
        } else if (m === 'DESIGN') {
          const dimgs = designVisible();
          dsel = dimgs.length === 0 ? 0 : Math.min(dimgs.length - 1, dsel + 1);
          refresh();
        }
        return;
      case 'left':
        if (m === 'IDLE') {
          caret = stepBack(text, caret);
          refresh();
        }
        return;
      case 'right':
        if (m === 'IDLE') {
          caret = stepForward(text, caret);
          refresh();
        }
        return;
      case 'home':
        if (m === 'IDLE') {
          caret = 0;
          refresh();
        }
        return;
      case 'end':
        if (m === 'IDLE') {
          caret = text.length;
          refresh();
        }
        return;
      default:
        break;
    }

    // Ctrl+其它字母等控制字符直接忽略
    if (k.ctrl || k.meta) return;

    // 可打印字符
    if (!str) return;
    if (m === 'FILE') return filePrintable(str);
    if (m === 'COMMAND') return commandPrintable(str);
    if (m === 'DESIGN') return designPrintable(str);

    if (str === '/' || str === '@' || str === '#') return triggerMode(str);
    insertAt(str);
    refresh();
  }

  /* ==================== 对外 API ==================== */

  return {
    start(handlers) {
      cfg = handlers;
      if (started || !process.stdin.isTTY) {
        // 非 TTY（如管道/测试）下不进入 raw 模式，直接退出流程
        if (!process.stdin.isTTY) requestExit();
        return;
      }
      started = true;
      stopped = false;
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.on('keypress', handleKey);
      process.stdin.resume();
      refresh();
    },
    /** 处理完成后（业务方也可主动）让界面回到干净空输入行 */
    reset() {
      if (busy) return;
      stopped = false;
      resetState();
      ensureInputFlowing();
      showEmptyPrompt();
    },
    stop() {
      if (!started) return;
      started = false;
      dropTrigger();
      process.stdin.removeListener('keypress', handleKey);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* 忽略 */
      }
    },
  };
}
