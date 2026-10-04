// CDP 实时追踪脚本：监听 Fetch/XHR 请求，定位 ultrafast → fast 的转换点
const CDP = require('chrome-remote-interface');

(async () => {
  const client = await CDP({ port: 9222 });
  const { Network, Runtime } = client;

  await Network.enable();
  await Runtime.enable();

  console.log('[CDP] 已连接，开始监听网络请求...\n');
  
  // 拦截所有 POST 请求
  Network.requestWillBeSent((params) => {
    const { request, requestId } = params;
    if (request.method === 'POST' && request.postData) {
      console.log(`\n[请求] ${request.method} ${request.url}`);
      try {
        const body = JSON.parse(request.postData);
        console.log(`  └─ Body:`, JSON.stringify(body, null, 2).slice(0, 800));
      } catch (e) {
        console.log(`  └─ postData: ${request.postData.slice(0, 300)}`);
      }
    }
  });

  // 监听响应
  Network.responseReceived((params) => {
    const { response } = params;
    if (response.url.includes('/models') || response.url.includes('config')) {
      console.log(`\n[响应] ${response.status} ${response.url}`);
    }
  });

  console.log('\n=== 操作指引 ===');
  console.log('1. 在应用里打开模型选择器，选中 Ultrafast');
  console.log('2. 发送一条消息');
  console.log('3. 观察下方输出的 service_tier 值');
  console.log('4. 按 Ctrl+C 结束监听\n');

})().catch(console.error);
