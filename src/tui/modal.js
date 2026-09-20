/**
 * 终端弹窗组件
 * @param {object} options
 * @param {string} options.title - 弹窗标题
 * @param {string[]} options.lines - 弹窗内容行
 * @param {string[]} [options.buttons] - 按钮文本列表，默认 ['确定']
 * @returns {Promise<number>} 用户选中的按钮索引
 */
export async function show(options) {
  const { title = '', lines = [], buttons = ['确定'] } = options;
  const width = 50;
  const border = '─';
  const corner = '╭';
  const cornerBR = '╯';
  const cornerBL = '╰';
  const cornerTR = '╮';
  const side = '│';

  // 绘制弹窗内容
  const frame = [];
  frame.push(` ${corner}${border.repeat(width - 2)}${cornerTR} `);
  if (title) {
    const padded = ` ${title} `.padEnd(width - 2, ' ');
    frame.push(`${side}${padded}${side}`);
    frame.push(` ${border.repeat(width - 2)} `);
  }
  for (const line of lines) {
    const padded = line.padEnd(width - 2, ' ');
    frame.push(`${side} ${padded} ${side}`);
  }
  frame.push(` ${border.repeat(width - 2)} `);

  // 按钮行
  const btnText = buttons.map((b, i) => `  [${i}] ${b}  `).join(' ');
  const btnPadded = btnText.padEnd(width - 2, ' ');
  frame.push(` ${cornerBL}${btnPadded}${cornerBR} `);

  // 计算偏移，使弹窗居中
  const cols = process.stdout.columns || 80;
  const offset = Math.max(0, Math.floor((cols - width) / 2));

  // 输出弹窗
  const out = frame.map(line => ' '.repeat(offset) + line).join('\n');
  console.log('\n' + out + '\n');

  // 等待用户输入选择
  return new Promise((resolve) => {
    const listener = (data) => {
      const input = data.toString().trim();
      const idx = parseInt(input, 10);
      if (!isNaN(idx) && idx >= 0 && idx < buttons.length) {
        process.stdin.removeListener('data', listener);
        resolve(idx);
      }
    };
    process.stdin.on('data', listener);
  });
}
