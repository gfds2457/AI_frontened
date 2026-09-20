/**
 * 终端绘制器 —— 只负责把「输入行 + 可选浮层」绘制到终端底部并跟踪占用的行数。
 *
 * 关键约定：
 *  - 绘制内容永远不换行（超出宽度做水平切片），所以 UI 块占用的终端行数是确定的；
 *  - 每次重绘前用 ansi-escapes.eraseLines 把上一次绘制的行数整块擦掉；
 *  - clear() 之后光标会停在一个「干净的空行行首」，供业务代码继续 console.log / 动画输出。
 */
import process from 'node:process';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { cursorHide, cursorShow, eraseLines } from 'ansi-escapes';
import { findPathTokens } from '../utils/fs/pathToken.js';

export const PROMPT = '你 > ';
export const PROMPT_WIDTH = stringWidth(PROMPT);

/** 路径标记的「浅蓝框」：浅蓝底 + 深蓝字（终端不支持彩色时 chalk 自动降级为纯文本） */
export const PATH_CHIP = chalk.bgHex('#bcd9ee').hex('#10243a');

// UI 块当前占用的终端行数（输入行 1 行 + 浮层行数）
let owned = 0;

// 流式回答区：自己维护一组行数，与上面的输入 UI 互不干扰（回答期间输入 UI 已被清除）
let answerRows = 0;

function write(s) {
  process.stdout.write(s);
}

/** 当前终端列数（非 TTY 时兜底 80） */
export function termCols() {
  return process.stdout.columns || 80;
}

/** 输入文本可用的列宽：整行宽度扣除提示符与 1 列余量 */
export function textAreaCols() {
  return Math.max(4, termCols() - PROMPT_WIDTH - 1);
}

function caretCellOf(text, caret) {
  return stringWidth(text.slice(0, caret));
}

/**
 * 把文本截到最接近 limitCells 的前缀，返回截断后的字符串。
 * 用于超长文件名 / 描述不至于把整行挤到换行（CJK 宽字符按 2 列计）。
 */
export function fitWidth(text, limitCells) {
  if (limitCells <= 0) return '';
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (w + cw > limitCells) break;
    out += ch;
    w += cw;
  }
  return out;
}

/**
 * 逐段上色并截宽一行：parts = [ [text, styleFn?], ... ]。
 * 截断规则与 fitWidth 完全一致（都是按列预算切前缀），所以「上色后的可见宽度」
 * 恒等于「原文的可见宽度」—— 输入行的光标定位依赖这一点。
 */
export function row(parts, limit) {
  let budget = limit;
  const out = [];
  for (const [raw, style] of parts) {
    const w = stringWidth(raw);
    if (budget <= 0) break;
    if (w <= budget) {
      out.push(style ? style(raw) : raw);
      budget -= w;
    } else {
      const cut = fitWidth(raw, budget);
      out.push(style ? style(cut) : cut);
      budget = 0;
    }
  }
  return out.join('');
}

/**
 * 给一段输入文本上色：命中的路径套浅蓝框，其余原样。
 * 返回结果与 fitWidth(text.slice(start), cols) 等宽，可直接替换原文上屏。
 * @param {string} text  完整输入文本
 * @param {number} start 可见窗口在 text 中的起点（水平滚动后的位置）
 * @param {number} cols  可用列宽
 */
export function highlightPaths(text, start, cols) {
  const slice = text.slice(start);
  const parts = [];
  let cur = 0;
  for (const t of findPathTokens(text)) {
    if (t.end <= start) continue; // 整个标记都在窗口左侧
    const s = Math.max(0, t.start - start);
    const e = t.end - start;
    if (s > cur) parts.push([slice.slice(cur, s), null]);
    parts.push([slice.slice(s, e), PATH_CHIP]);
    cur = e;
  }
  if (cur < slice.length) parts.push([slice.slice(cur), null]);
  return row(parts, cols);
}

/**
 * 计算水平滚动窗口：文本总宽超过可用列时，向左/右调整窗口起点，
 * 保证光标始终落在可见区域内、且输入行从不换行。
 * @returns {{visible: string, caretCell: number, start: number}} start 供上色时定位标记
 */
function computeWindow(text, caret) {
  const area = textAreaCols();
  const caretCell = caretCellOf(text, caret);
  if (stringWidth(text) <= area) {
    return { visible: text, caretCell, start: 0 };
  }

  let start = 0;
  let startCell = 0;
  // 光标超出右侧 -> 向右滚
  while (start < text.length && startCell + area - 1 < caretCell) {
    startCell += stringWidth(text[start]);
    start += 1;
  }
  // 光标被滚出左侧 -> 向左回滚
  while (start > 0 && caretCell < startCell) {
    start -= 1;
    startCell -= stringWidth(text[start]);
  }
  const visible = fitWidth(text.slice(start), area);
  return { visible, caretCell: caretCell - startCell, start };
}

/** 水平绝对定位到第 col 列（0 基）；用最朴素的 ANSI 序列，规避宽字符移动歧义 */
function col(col) {
  return `\x1b[${col + 1}G`;
}

/**
 * 重绘整个 UI 块。
 * @param {string} text  输入框当前完整文本
 * @param {number} caret 光标在 text 中的位置（UTF-16 下标）
 * @param {string[]} overlayLines 浮层各行（已经过调用方上色/截宽）
 */
export function redraw(text, caret, overlayLines = []) {
  const { caretCell, start } = computeWindow(text, caret);
  const rows = 1 + overlayLines.length;

  let out = cursorHide;
  if (owned > 0) out += eraseLines(owned);
  out += chalk.bold.cyan(PROMPT) + highlightPaths(text, start, textAreaCols());
  out += col(PROMPT_WIDTH + caretCell);
  for (const line of overlayLines) out += `\n${line}`;
  out += cursorShow;

  write(out);
  owned = rows;
}

/** 移除 UI 块；随后光标停在原输入行行首的空行，供业务输出使用 */
export function clear() {
  if (owned > 0) {
    write(cursorHide + eraseLines(owned));
    owned = 0;
    write(cursorShow);
  }
}

/** 在一轮处理后重画一个空的输入行 */
export function showEmptyPrompt() {
  redraw('', 0);
}

/**
 * 提交回显：把用户刚输入的内容固化成一条会话记录（`你 > …`），
 * 替代原先 readline 的自动回显，避免发送后输入内容从屏幕上消失。
 * 这里的回显允许长于终端宽度（终端自然折行），所以列宽传 Infinity 不做截断。
 */
export function commitInput(text) {
  let out = cursorHide;
  if (owned > 0) out += eraseLines(owned);
  owned = 0;
  out += chalk.bold.cyan(PROMPT) + highlightPaths(text, 0, Infinity) + '\n';
  out += cursorShow;
  write(out);
}

/* ==================== 流式回答区（markdown 边收边渲染） ==================== */

/** 重置流式回答区状态（每次新回答前调用） */
export function resetAnswer() {
  answerRows = 0;
}

/**
 * 计算一组终言行（已上色、未换行的逻辑行）实际占用的物理行数。
 * 长行按终端宽度折算换行，用于精确擦除。
 */
export function measureRows(lines) {
  const cols = Math.max(1, termCols());
  let rows = 0;
  for (const line of lines) {
    const c = stringWidth(line);
    rows += c <= 0 ? 1 : Math.floor((c - 1) / cols) + 1;
  }
  return rows;
}

/**
 * 在受管回答区内整块重绘（仅当 measureRows(lines) ≤ 容量时调用，
 * 保证整块始终落在可视区域内、可被精确擦除）。
 */
export function drawAnswer(lines) {
  let out = cursorHide;
  if (answerRows > 0) out += eraseLines(answerRows);
  out += lines.join('\n');
  out += cursorShow;
  write(out);
  answerRows = measureRows(lines);
}

/**
 * 回答超过可视容量时，一次性把当前整块打印出来（允许终端自然滚动），
 * 此后本回答转为“追加原始文本”模式，不再整块擦除。
 */
export function spillAnswer(lines) {
  let out = cursorHide;
  if (answerRows > 0) out += eraseLines(answerRows);
  out += lines.join('\n');
  out += cursorShow;
  write(out);
  answerRows = 0;
}

/** 溢出后的追加模式：直接输出新增的原始文本 */
export function appendAnswerRaw(text) {
  write(text);
}

/**
 * 回答结束收尾：若末尾没有换行则补一个，让光标落到新行行首，
 * 供之后的输入行 / 其它输出使用；同时清空回答区状态。
 */
export function endAnswer(endedWithNewline) {
  if (!endedWithNewline) write('\n');
  answerRows = 0;
}

/** 退出前：清除 UI 并给业务收尾输出留一个换行后的位置 */
export function teardown() {
  clear();
  write('\n');
}

/** 恢复光标显示：强制退出等不走 teardown 的路径要调一下，别让终端停在隐藏光标状态 */
export function restoreCursor() {
  write(cursorShow);
}
