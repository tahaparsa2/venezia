// QR codes for pairing: an SVG for screens and blocks for a terminal.

import qrcode from 'qrcode-generator';

function matrix(text) {
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  const size = code.getModuleCount();
  return { size, dark: (row, column) => code.isDark(row, column) };
}

/** @param {string} text */
export function qrSvg(text) {
  const { size, dark } = matrix(text);
  const quiet = 4;
  const cells = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (dark(row, column)) cells.push(`M${column + quiet} ${row + quiet}h1v1h-1z`);
    }
  }
  const full = size + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">`
    + `<rect width="${full}" height="${full}" fill="#fff"/><path fill="#000" d="${cells.join('')}"/></svg>`;
}

/** Two rows of modules per line of text, using half blocks, so it scans from a terminal. */
export function qrTerminal(text) {
  const { size, dark } = matrix(text);
  const quiet = 2;
  const isDark = (row, column) => row >= 0 && column >= 0 && row < size && column < size && dark(row, column);
  const lines = [];
  for (let row = -quiet; row < size + quiet; row += 2) {
    let line = '';
    for (let column = -quiet; column < size + quiet; column++) {
      const top = isDark(row, column);
      const bottom = isDark(row + 1, column);
      if (top && bottom) line += ' ';
      else if (top) line += '▄';
      else if (bottom) line += '▀';
      else line += '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
