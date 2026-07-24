document.getElementById('shot-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({type: 'launch'});
  window.close();
});

// Chrome標準のショートカット設定ページを開く（chrome://はリンク不可のためtabsで開く）
document.getElementById('change-shortcut').addEventListener('click', () => {
  chrome.tabs.create({url: 'chrome://extensions/shortcuts'});
  window.close();
});
