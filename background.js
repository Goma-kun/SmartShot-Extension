async function launchOverlay(tabId, windowId) {
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
  if (tab) await launchOverlay(tab.id, tab.windowId);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'download') {
    chrome.downloads.download({url: msg.dataUrl, filename: msg.filename, saveAs: false});
  }
  if (msg.type === 'launch') {
    chrome.tabs.query({active: true, currentWindow: true}).then(([tab]) => {
      if (tab) launchOverlay(tab.id, tab.windowId);
    });
  }
});
