const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 4567;
const AUTH_FILE = path.join(__dirname, 'jio_tokens.json');

// Spoof headers expected by JioTV CDN and APIs
const JIO_API_HEADERS = {
  'User-Agent': 'okhttp/4.9.3',
  'appkey': 'NzNiMDhlYzQyNjJm',
  'devicetype': 'phone',
  'os': 'android',
  'osversion': '13',
  'versionCode': '330'
};

const PLAYER_HEADERS = {
  'User-Agent': 'plaYtv/7.1.5 (Linux;Android 13) ExoPlayerLib/2.11.7'
};

let sessionCookies = {}; // Stores channel-specific __hdnea__ cookies

function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function saveAuth(data) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Helper for HTTPS requests
function requestUrl(targetUrl, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.path,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const proto = parsed.protocol === 'http:' ? http : https;
    const req = proto.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // Enable CORS for the Tizen Chromium frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedReq = url.parse(req.url, true);
  const pathname = parsedReq.pathname;

  try {
    // 1. Fetch Live Channel Catalog
    if (pathname === '/channels') {
      const catalogUrl = 'https://jiotvapi.cdn.jio.com/apis/v3.0/getMobileChannelList/get/?langId=6&os=android&devicetype=phone&usertype=JIO&version=330';
      const response = await requestUrl(catalogUrl, { headers: JIO_API_HEADERS });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(response.body);
    }

    // 2. Send OTP
    if (pathname === '/login/send-otp' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const { phone } = JSON.parse(body);
        const b64Phone = Buffer.from('+91' + phone).toString('base64');
        const payload = JSON.stringify({ number: b64Phone });

        const otpRes = await requestUrl(
          'https://jiotvapi.media.jio.com/userservice/apis/v1/loginotp/send',
          {
            method: 'POST',
            headers: Object.assign({}, JIO_API_HEADERS, {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            })
          },
          payload
        );
        res.writeHead(otpRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(otpRes.body);
      });
      return;
    }

    // 3. Verify OTP & Save Tokens
    if (pathname === '/login/verify-otp' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const { phone, otp } = JSON.parse(body);
        const b64Phone = Buffer.from('+91' + phone).toString('base64');
        const payload = JSON.stringify({
          number: b64Phone,
          otp: otp,
          deviceInfo: {
            consumptionDeviceName: 'SM-G998B',
            info: {
              type: 'android',
              platform: { name: 'SM-G998B' },
              androidId: 'tizenbrew_jiotv_device_01'
            }
          }
        });

        const verifyRes = await requestUrl(
          'https://jiotvapi.media.jio.com/userservice/apis/v1/loginotp/verify',
          {
            method: 'POST',
            headers: Object.assign({}, JIO_API_HEADERS, {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            })
          },
          payload
        );

        if (verifyRes.statusCode === 200) {
          saveAuth(JSON.parse(verifyRes.body.toString()));
        }
        res.writeHead(verifyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(verifyRes.body);
      });
      return;
    }

    // 4. Master HLS Stream Endpoint (/live?id=144)
    if (pathname === '/live.m3u8') {
      const channelId = parsedReq.query.id;
      const auth = loadAuth();
      if (!auth || !auth.authToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not logged in' }));
      }

      const postForm = `stream_type=Seek&channel_id=${channelId}`;
      const playbackHeaders = Object.assign({}, JIO_API_HEADERS, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'accesstoken': auth.authToken,
        'ssotoken': auth.ssoToken || '',
        'crmid': auth.sessionAttributes.user.subscriberId,
        'uniqueId': auth.sessionAttributes.user.unique,
        'userId': auth.sessionAttributes.user.uid,
        'deviceId': 'tizenbrew_jiotv_device_01'
      });

      const pbRes = await requestUrl(
        'https://jiotvapi.media.jio.com/playback/apis/v1/geturl?langId=6',
        { method: 'POST', headers: playbackHeaders },
        postForm
      );

      const pbData = JSON.parse(pbRes.body.toString());
      if (!pbData.result) {
        res.writeHead(502);
        return res.end('Failed to obtain stream URL');
      }

      const streamUrl = pbData.result;
      const hdneaMatch = streamUrl.match(/(__hdnea__=[^&]+)/);
      if (hdneaMatch) {
        sessionCookies[channelId] = hdneaMatch[1];
      }

      // Fetch the initial M3U8 manifest
      const m3u8Res = await requestUrl(streamUrl, {
        headers: Object.assign({}, PLAYER_HEADERS, {
          'Cookie': sessionCookies[channelId] || ''
        })
      });

      if (m3u8Res.headers['set-cookie']) {
        sessionCookies[channelId] = m3u8Res.headers['set-cookie'][0].split(';')[0];
      }

      const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
      const rewrittenM3u8 = rewriteManifest(m3u8Res.body.toString(), baseUrl, channelId);

      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(rewrittenM3u8);
    }

    // 5. Segment (.ts), Variant (.m3u8), and AES Key (.key) Proxy
    if (pathname === '/proxy') {
      const target = parsedReq.query.url;
      const channelId = parsedReq.query.cid;
      const cookie = sessionCookies[channelId] || '';

      const proxyRes = await requestUrl(target, {
        headers: Object.assign({}, PLAYER_HEADERS, {
          'Cookie': cookie
        })
      });

      if (target.includes('.m3u8')) {
        const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
        const rewritten = rewriteManifest(proxyRes.body.toString(), baseUrl, channelId);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(rewritten);
      }

      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'video/MP2T'
      });
      return res.end(proxyRes.body);
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    res.writeHead(500);
    res.end(err.toString());
  }
});

// Rewrites relative .m3u8, .ts, and AES-128 URI="..." links to point to local proxy
function rewriteManifest(manifestText, baseUrl, channelId) {
  return manifestText.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Rewrite AES-128 Key URI inside #EXT-X-KEY
    if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI="')) {
      return trimmed.replace(/URI="([^"]+)"/, (match, keyUri) => {
        const fullKeyUrl = keyUri.startsWith('http') ? keyUri : baseUrl + keyUri;
        return `URI="http://127.0.0.1:${PORT}/proxy?cid=${channelId}&url=${encodeURIComponent(fullKeyUrl)}"`;
      });
    }

    if (trimmed.startsWith('#')) return line;

    // Rewrite child .m3u8 or .ts segment lines
    const fullTargetUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
    return `http://127.0.0.1:${PORT}/proxy?cid=${channelId}&url=${encodeURIComponent(fullTargetUrl)}`;
  }).join('\n');
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`JioTV+ TizenBrew Proxy running on http://127.0.0.1:${PORT}`);
});