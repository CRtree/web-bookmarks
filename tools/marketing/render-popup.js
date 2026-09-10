const path = require('path');
const { chromium } = require(path.join(__dirname, '..', '..', 'node_modules', 'playwright'));

// Render the real extension popup (popup.html + popup.css + popup.js) for each
// theme with a mocked chrome.* API. Outputs are written at 2x (1280x800) so the
// final 640x400 screenshots can be downscaled crisply. Pass the output dir as
// argv[2] (defaults to ./out next to this script).
const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = process.argv[2] || path.join(__dirname, 'out');
const POPUP_HTML = 'file://' + path.join(ROOT, 'popup.html');

function chromeMock(theme) {
  return `
    window.__THEME__ = '${theme}';
    window.chrome = (function(){
      var now = Date.now();
      var positions = {
        'https://www.youtube.com/@LearnEnglishWithBobtheCanadian/shorts':
          { videoId:'1XfSk8NkBRQ', type:'shorts', timestamp: now - 30*60*1000 },
        'https://www.youtube.com/@LearnEnglishWithBobtheCanadian/videos':
          { videoId:'AHpyC1mKcd4', type:'video', timestamp: now - 4*24*3600*1000 }
      };
      var store = { theme: window.__THEME__ };
      var responses = {
        ping: { ok:true },
        get_extension_enabled: { enabled:false },
        get_current_tab_position: { position:null },
        get_positions: { positions: positions },
        get_all_logs: { logs:[] },
        clear_position: { success:true },
        clear_all: { success:true },
        set_extension_enabled: { success:true }
      };
      return {
        runtime: {
          lastError: null,
          sendMessage: function(msg, cb){
            var a = msg && msg.action;
            if (a === 'store_log'){ if(cb) setTimeout(function(){ window.chrome.runtime.lastError = null; cb({}); }, 0); return; }
            var resp = (a && responses[a] !== undefined) ? responses[a] : {};
            if (cb) setTimeout(function(){ window.chrome.runtime.lastError = null; cb(resp); }, 0);
          }
        },
        storage: {
          local: {
            get: function(keys, cb){
              var result = {};
              window.chrome.runtime.lastError = null;
              if (keys === null) result = Object.assign({}, store, { positions: positions });
              else if (Array.isArray(keys)) keys.forEach(function(k){ result[k] = store[k]; });
              else result[keys] = store[keys];
              setTimeout(function(){ cb(result); }, 0);
            },
            set: function(obj, cb){ Object.assign(store, obj); if(cb) setTimeout(cb, 0); }
          }
        },
        tabs: {
          query: function(q, cb){ setTimeout(function(){ cb([{ url:'chrome://newtab/', title:'\\u65b0\\u6807\\u7b7e\\u9875' }]); }, 0); },
          create: function(o, cb){ if(cb) setTimeout(function(){ cb({}); }, 0); }
        }
      };
    })();
  `;
}

(async () => {
  const browser = await chromium.launch();
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({
      viewport: { width: 640, height: 400 },
      deviceScaleFactor: 2,
    });
    await page.addInitScript(chromeMock(theme));
    await page.goto(POPUP_HTML);
    await page.waitForTimeout(700);
    await page.screenshot({
      path: path.join(OUT_DIR, `marketing-screenshot-${theme}-1280x800.png`),
      clip: { x: 0, y: 0, width: 640, height: 400 },
      caret: 'hide',
    });
    await page.close();
    console.log('rendered popup-' + theme);
  }
  await browser.close();
})();
