document.getElementById('shot-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({type: 'launch'});
  window.close();
});
