// Quick test script for docs_get_content
import http from 'http';

const COOKIE = process.argv[2];
const DOC_ID = '13x4JSw1RcyWrF1vAcDv_-N5n73fr7-q92mR_tmEmb70';

if (!COOKIE) {
  console.error('Usage: node test-docs.mjs <connect.sid cookie value>');
  process.exit(1);
}

// Step 1: Connect to SSE and get sessionId
const sseReq = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/mcp/sse',
  method: 'GET',
  headers: {
    'Cookie': `connect.sid=${COOKIE}`,
    'Accept': 'text/event-stream'
  }
}, (res) => {
  let sessionId = null;
  
  res.on('data', (chunk) => {
    const data = chunk.toString();
    // Parse SSE event to get sessionId from endpoint event
    if (data.includes('event: endpoint')) {
      const match = data.match(/sessionId=([a-zA-Z0-9-]+)/);
      if (match) {
        sessionId = match[1];
        console.log('Got sessionId:', sessionId);
        
        // Step 2: Call docs_get_content
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'docs_get_content',
            arguments: { documentId: DOC_ID }
          }
        });
        
        const msgReq = http.request({
          hostname: 'localhost',
          port: 3000,
          path: `/mcp/message?sessionId=${sessionId}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, (msgRes) => {
          let body = '';
          msgRes.on('data', c => body += c);
          msgRes.on('end', () => {
            console.log('Response status:', msgRes.statusCode);
          });
        });
        
        msgReq.write(payload);
        msgReq.end();
      }
    }
    
    // Look for the tool result in SSE stream
    if (data.includes('"result"') || data.includes('"error"')) {
      console.log('\n--- Tool Response ---');
      // Extract JSON from SSE data field
      const lines = data.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const json = JSON.parse(line.slice(6));
            console.log(JSON.stringify(json, null, 2));
            process.exit(0);
          } catch (e) {}
        }
      }
    }
  });
});

sseReq.on('error', (e) => {
  console.error('SSE connection error:', e.message);
});

sseReq.end();

// Timeout after 10s
setTimeout(() => {
  console.log('Timeout - no response received');
  process.exit(1);
}, 10000);
