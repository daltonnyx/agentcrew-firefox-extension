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

    browser.contextMenus.create({
      id: 'agentcrew-generate',
      title: 'Generate content with AgentCrew',
      contexts: ['editable']
    });
  });
}

export function removeContextMenus() {
  browser.contextMenus.removeAll();
}