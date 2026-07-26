document.getElementById('shot-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({type: 'launch'});
  window.close();
});

// Chrome標準のショートカット設定ページを開く（chrome://はリンク不可のためtabsで開く）
document.getElementById('change-shortcut').addEventListener('click', () => {
  chrome.tabs.create({url: 'chrome://extensions/shortcuts'});
  window.close();
});

// 直近の起動履歴を表示（意図しない起動の原因を確認するため）
chrome.storage.session.get(['smartshot_log'], ({smartshot_log}) => {
  const box = document.getElementById('log');
  if (!smartshot_log || !smartshot_log.length) return;
  box.innerHTML = '<b>最近の起動</b>' +
    smartshot_log.slice(0, 3)
      .map(e => `<div>${e.at} — ${e.trigger}</div>`)
      .join('');
});
