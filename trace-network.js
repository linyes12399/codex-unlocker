const CDP = require('chrome-remote-interface');

(async () => {
  try {
    // List all targets first
    const targets = await CDP.List({ port: 9222 });
    console.log('Available targets:');
    targets.forEach(t => console.log(`  [${t.type}] ${t.title} - ${t.id}`));
    
    // Connect to the main page (type: 'page', not 'webview')
    const mainPage = targets.find(t => t.type === 'page' && t.url.startsWith('app://'));
    if (!mainPage) {
      console.error('Main page not found');
      process.exit(1);
    }
    
    console.log(`\nConnecting to: ${mainPage.title}`);
    const client = await CDP({ port: 9222, target: mainPage.id });
    const { Network } = client;

    await Network.enable();
    
    console.log('=== Monitoring all network traffic ===\n');

    // Monitor HTTP requests
    Network.requestWillBeSent((params) => {
      const { request } = params;
      if (request.method === 'POST' && request.postData) {
        console.log(`\n[HTTP POST] ${request.url}`);
        console.log('Body:', request.postData.slice(0, 500));
      }
    });

    // Monitor WebSocket frames
    Network.webSocketCreated((params) => {
      console.log(`\n[WebSocket Created] ${params.url}`);
    });

    Network.webSocketFrameSent((params) => {
      console.log(`\n[WS SENT] ${params.response.payloadData.slice(0, 1000)}`);
    });

    Network.webSocketFrameReceived((params) => {
      const data = params.response.payloadData;
      if (data.includes('serviceTier') || data.includes('service_tier') || 
          data.includes('thinking') || data.includes('model')) {
        console.log(`\n[WS RECEIVED] ${data.slice(0, 2000)}`);
      }
    });

    // Keep running
    await new Promise(() => {});
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
