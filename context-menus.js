export function createContextMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: 'agentcrew-selection',
      title: 'Send selection to AgentCrew',
      contexts: ['selection']
    });

    browser.contextMenus.create({
      id: 'agentcrew-image',
      title: 'Send image to AgentCrew',
      contexts: ['image']
    });
  });
}

export function removeContextMenus() {
  browser.contextMenus.removeAll();
}