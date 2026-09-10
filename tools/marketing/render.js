const path = require('path');
const { chromium } = require(path.join(__dirname, '..', '..', 'node_modules', 'playwright'));

// Usage: node render.js <input.html> <output.png> <width> <height> [bgColor]
const [,, input, output, wStr, hStr, bg = '#000000'] = process.argv;
const width = parseInt(wStr, 10);
const height = parseInt(hStr, 10);
const absInput = path.resolve(input);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  await page.goto('file://' + absInput);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: output,
    fullPage: false,
    clip: { x: 0, y: 0, width, height },
    type: 'png',
    caret: 'hide',
  });
  await browser.close();
  console.log('rendered', output, width + 'x' + height);
})();
