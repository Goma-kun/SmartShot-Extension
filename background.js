// コンテンツスクリプト(overlay.js)から storage.session を読めるようにする
// （MV3のデフォルトは TRUSTED_CONTEXTS のみで、これが無いとオーバーレイが起動しない）
chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'});

// 起動履歴（意図しない起動の原因切り分け用）。
// chrome://extensions → SmartShot の「Service Worker」を開くとこのログが見られる。
// 表示は行わずメッセージキーで保存し、ポップアップ側で表示言語に合わせて解決する
async function logLaunch(triggerKey) {
  const entry = {triggerKey, at: new Date().toLocaleTimeString()};
  console.log('[SmartShot] launched:', triggerKey, entry.at);
  try {
    const {smartshot_log = []} = await chrome.storage.session.get(['smartshot_log']);
    smartshot_log.unshift(entry);
    await chrome.storage.session.set({smartshot_log: smartshot_log.slice(0, 20)});
  } catch (_) { }
}

async function launchOverlay(tabId, windowId, triggerKey) {
  logLaunch(triggerKey || 'unknown');
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {format: 'png'});
    await chrome.storage.session.set({smartshot_img: dataUrl});
    await chrome.scripting.executeScript({target: {tabId}, files: ['overlay.js']});
  } catch (e) {
    // 新しいタブページや chrome:// 系、ウェブストアには拡張機能を注入できない（Chromeの制約）。
    // ページ側には何も出せないので、ポップアップを自動で開いて理由を伝える。
    // バッジは openPopup が使えない環境（古いChrome等）のための保険。
    console.error('[SmartShot]', e.message);
    await chrome.storage.session.set({smartshot_blocked: Date.now()});
    chrome.action.setBadgeText({text: '×'});
    chrome.action.setBadgeBackgroundColor({color: '#ef4444'});
    setTimeout(() => chrome.action.setBadgeText({text: ''}), 6000);
    try { await chrome.action.openPopup(); } catch (_) { /* 開けない環境ではバッジのみ */ }
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'take-screenshot') return;
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab) await launchOverlay(tab.id, tab.windowId, 'triggerShortcut');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'download') {
    chrome.downloads.download({url: msg.dataUrl, filename: msg.filename, saveAs: false});
  }
  if (msg.type === 'launch') {
    chrome.tabs.query({active: true, currentWindow: true}).then(([tab]) => {
      if (tab) launchOverlay(tab.id, tab.windowId, 'triggerPopup');
    });
  }
});

// オーバーレイからの再キャプチャ要求（スクロールで撮影位置を変えたとき）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'recapture') return;
  const winId = sender.tab ? sender.tab.windowId : undefined;
  chrome.tabs.captureVisibleTab(winId, {format: 'png'})
    .then(dataUrl => sendResponse({dataUrl}))
    .catch(() => sendResponse({dataUrl: null}));
  return true; // 非同期でレスポンスを返す
});
