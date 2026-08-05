// data-i18n を持つ要素に、ブラウザの言語に応じたテキストを流し込む
for (const el of document.querySelectorAll('[data-i18n]')) {
  const msg = chrome.i18n.getMessage(el.dataset.i18n);
  if (msg) el.textContent = msg;
}

document.getElementById('shot-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({type: 'launch'});
  window.close();
});

// 直前に「使えないページ」で起動しようとした場合、その理由を最上部に表示する。
// 注入できないページではトーストを出せないため、ポップアップ側で伝えるしかない。
chrome.storage.session.get(['smartshot_blocked'], ({smartshot_blocked}) => {
  if (smartshot_blocked && Date.now() - smartshot_blocked < 60000) {
    document.getElementById('blocked').style.display = 'block';
    chrome.storage.session.remove('smartshot_blocked');   // 一度見せたら消す
  }
});

// 実際に割り当てられているショートカットを表示する。
// manifest の suggested_key は「初期値の提案」でしかなく、ユーザーが変更していたり
// ブラウザ標準のキー（⌘A、⌘S など）と競合して未割り当てのままのこともあるため、
// 固定文字列ではなく chrome.commands から実際の割り当てを読む。
chrome.commands.getAll((cmds) => {
  const el = document.getElementById('shortcut-key');
  const cmd = cmds.find(c => c.name === 'take-screenshot');
  if (cmd && cmd.shortcut) {
    el.textContent = cmd.shortcut;
  } else {
    el.textContent = chrome.i18n.getMessage('shortcutUnset') || 'Not set';
    el.style.color = '#fb923c';   // 未設定は色を変えて気づけるようにする
  }
});

// Chrome標準のショートカット設定ページを開く（chrome://はリンク不可のためtabsで開く）
document.getElementById('change-shortcut').addEventListener('click', () => {
  chrome.tabs.create({url: 'chrome://extensions/shortcuts'});
  window.close();
});

// 撮影後の動作（コピーのみ／コピーして保存／保存のみ）
const saveMode = document.getElementById('save-mode');
const MODE_KEYS = {copy:'modeCopy', both:'modeBoth', save:'modeSave'};
for (const opt of saveMode.options) {
  opt.textContent = chrome.i18n.getMessage(MODE_KEYS[opt.value]) || opt.value;
}
chrome.storage.local.get(['smartshot_savemode'], ({smartshot_savemode}) => {
  saveMode.value = smartshot_savemode || 'both';   // 既定は従来どおり「コピーして保存」
});
saveMode.addEventListener('change', () => {
  chrome.storage.local.set({smartshot_savemode: saveMode.value});
});

// 直近の起動履歴を表示（意図しない起動の原因を確認するため）
chrome.storage.session.get(['smartshot_log'], ({smartshot_log}) => {
  const box = document.getElementById('log');
  if (!smartshot_log || !smartshot_log.length) return;
  const title = chrome.i18n.getMessage('popupRecentLaunches');
  box.innerHTML = `<b>${title}</b>` +
    smartshot_log.slice(0, 3)
      .map(e => `<div>${e.at} — ${chrome.i18n.getMessage(e.triggerKey) || e.triggerKey}</div>`)
      .join('');
});
