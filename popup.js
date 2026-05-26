document.getElementById('pick-btn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) {
    window.close();
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'startSelection' });
  } catch (e) {
    console.error('PageToLLM popup: sendMessage failed', e);
  }
  window.close();
});

document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
});
