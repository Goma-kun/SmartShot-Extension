// コンテンツスクリプト(overlay.js)から storage.session を読めるようにする
// （MV3のデフォルトは TRUSTED_CONTEXTS のみで、これが無いとオーバーレイが起動しない）
chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'});

// 起動履歴（意図しない起動の原因切り分け用）。
// chrome://extensions → SmartShot の「Service Worker」を開くとこのログが見られる。
async function logLaunch(trigger) {
  const entry = {trigger, at: new Date().toLocaleTimeString('ja-JP')};
  console.log('[SmartShot] 起動:', entry.trigger, entry.at);
  try {
    const {smartshot_log = []} = await chrome.storage.session.get(['smartshot_log']);
    smartshot_log.unshift(entry);
    await chrome.storage.session.set({smartshot_log: smartshot_log.slice(0, 20)});
  } catch (_) { }
}

async function launchOverlay(tabId, windowId, trigger) {
  logLaunch(trigger || 'unknown');
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {format: 'png'});
    await chrome.storage.session.set({smartshot_img: dataUrl});
    await chrome.scripting.executeScript({target: {tabId}, files: ['overlay.js']});
  } catch (e) {
    console.error('[SmartShot]', e.message);
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'take-screenshot') return;
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab) await launchOverlay(tab.id, tab.windowId, 'ショートカットキー');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'download') {
    chrome.downloads.download({url: msg.dataUrl, filename: msg.filename, saveAs: false});
  }
  if (msg.type === 'launch') {
    chrome.tabs.query({active: true, currentWindow: true}).then(([tab]) => {
      if (tab) launchOverlay(tab.id, tab.windowId, 'ポップアップのボタン');
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
