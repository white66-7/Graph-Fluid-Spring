// 临时调试脚本：按行打印，把 < > 换成 « »，避免工具输出层把尖括号当 HTML 标签吞掉
const fs = require('fs');
const file = process.argv[2];
const from = parseInt(process.argv[3] || '1', 10);
const to = parseInt(process.argv[4] || '0', 10);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const end = to > 0 ? Math.min(to, lines.length) : lines.length;
for (let i = from; i <= end; i++) {
  const t = lines[i - 1]
    .replaceAll('<', '«')
    .replaceAll('>', '»');
  console.log(i + ': ' + t);
}
