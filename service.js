'use strict';

var http = require('http');
var https = require('https');
var url = require('url');
var fs = require('fs');

var PORT = 4567;
var AUTH_FILE = '/tmp/jio_tokens.json';

var JIO_API_HEADERS = {
  'User-Agent': 'okhttp/4.9.3',
  'appkey': 'NzNiMDhlYzQyNjJm',
  'devicetype': 'phone',
  'os': 'android',
  'osversion': '13',
  'versionCode': '330'
};

var PLAYER_HEADERS = {
  'User-Agent': 'plaYtv/7.1.5 (Linux;Android 13) ExoPlayerLib/2.11.7'
};

var sessionCookies = {};
var memoryAuth = null;

// Safe Base64 helper for Node.js 4.4.3
function toBase64(str) {
  try {
    return new Buffer(str).toString('base64');
  } catch (e) {
    return Buffer.from(str).toString('base64');
  }
}

function loadAuth() {
  if (memoryAuth) return memoryAuth;
  try {
    if (fs.existsSync(AUTH_FILE)) {
      memoryAuth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      return memoryAuth;
    }
  } catch (e) {}
  return null;
}

function saveAuth(data) {
  memoryAuth = data;
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data), 'utf8');
  } catch (e) {}
}

function assignHeaders(base, extra) {
  var out = {};
  var k;
  for (k in base) {
    if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
  }
  if (extra) {
    for (k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    }
  }
  return out;
}

// Pure callback HTTPS/HTTP helper (No async/await or default params)
function requestUrl(targetUrl, options, postData, callback) {
  try {
    var parsed = url.parse(targetUrl);
    var isHttp = parsed.protocol === 'http:';
    var reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttp ? 80 : 443),
      path: parsed.path,
      method: (options && options.method) ? options.method : 'GET',
      headers: (options && options.headers) ? options.headers : {},
      rejectUnauthorized: false
    };

    var proto = isHttp ? http : https;
    var req = proto.request(reqOpts, function(res) {
      var chunks = [];
      res.on('data', function(chunk) {
        chunks.push(chunk);
      });
      res.on('end', function() {
        callback(null, {
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });

    req.on('error', function(err) {
      callback(err, null);
    });

    if (postData) req.write(postData);
    req.end();
  } catch (err) {
    callback(err, null);
  }
}

function rewriteManifest(manifestText, baseUrl, channelId) {
  var lines = manifestText.split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }

    if (trimmed.indexOf('#EXT-X-KEY') === 0 && trimmed.indexOf('URI="') !== -1) {
      out.push(trimmed.replace(/URI="([^"]+)"/, function(match, keyUri) {
        var fullKeyUrl = keyUri.indexOf('http') === 0 ? keyUri : baseUrl + keyUri;
        return 'URI="http://127.0.0.1:' + PORT + '/proxy?cid=' + channelId + '&url=' + encodeURIComponent(fullKeyUrl) + '"';
      }));
      continue;
    }

    if (trimmed.indexOf('#') === 0) {
      out.push(line);
      continue;
    }

    var fullTargetUrl = trimmed.indexOf('http') === 0 ? trimmed : baseUrl + trimmed;
    out.push('http://127.0.0.1:' + PORT + '/proxy?cid=' + channelId + '&url=' + encodeURIComponent(fullTargetUrl));
  }
  return out.join('\n');
}

var server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  var parsedReq = url.parse(req.url, true);
  var pathname = parsedReq.pathname;

  // 0. Health Check
  if (pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', node: process.version }));
    return;
  }

  // 1. Fetch Live Channel Catalog
  if (pathname === '/channels') {
    var catalogUrl = 'https://jiotvapi.cdn.jio.com/apis/v3.0/getMobileChannelList/get/?langId=6&os=android&devicetype=phone&usertype=JIO&version=330';
    requestUrl(catalogUrl, { headers: JIO_API_HEADERS }, null, function(err, response) {
      if (err || !response) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(response.body);
    });
    return;
  }

  // 2. Send OTP
  if (pathname === '/login/send-otp' && req.method === 'POST') {
    var body1 = '';
    req.on('data', function(chunk) { body1 += chunk; });
    req.on('end', function() {
      try {
        var parsedBody = JSON.parse(body1);
        var b64Phone = toBase64('+91' + parsedBody.phone);
        var payload = JSON.stringify({ number: b64Phone });

        requestUrl(
          'https://jiotvapi.media.jio.com/userservice/apis/v1/loginotp/send',
          {
            method: 'POST',
            headers: assignHeaders(JIO_API_HEADERS, {
              'Content-Type': 'application/json',
              'Content-Length': String( payload.length )
            })
          },
          payload,
          function(err, otpRes) {
            if (err || !otpRes) {
              res.writeHead(500);
              res.end(String(err));
              return;
            }
            res.writeHead(otpRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(otpRes.body);
          }
        );
      } catch (e) {
        res.writeHead(400);
        res.end(String(e));
      }
    });
    return;
  }

  // 3. Verify OTP
  if (pathname === '/login/verify-otp' && req.method === 'POST') {
    var body2 = '';
    req.on('data', function(chunk) { body2 += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body2);
        var b64Phone = toBase64('+91' + data.phone);
        var payload = JSON.stringify({
          number: b64Phone,
          otp: data.otp,
          deviceInfo: {
            consumptionDeviceName: 'SM-G998B',
            info: {
              type: 'android',
              platform: { name: 'SM-G998B' },
              androidId: 'tizenbrew_jiotv_device_01'
            }
          }
        });

        requestUrl(
          'https://jiotvapi.media.jio.com/userservice/apis/v1/loginotp/verify',
          {
            method: 'POST',
            headers: assignHeaders(JIO_API_HEADERS, {
              'Content-Type': 'application/json',
              'Content-Length': String(payload.length)
            })
          },
          payload,
          function(err, verifyRes) {
            if (err || !verifyRes) {
              res.writeHead(500);
              res.end(String(err));
              return;
            }
            if (verifyRes.statusCode === 200) {
              try {
                saveAuth(JSON.parse(verifyRes.body.toString()));
              } catch (e) {}
            }
            res.writeHead(verifyRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(verifyRes.body);
          }
        );
      } catch (e) {
        res.writeHead(400);
        res.end(String(e));
      }
    });
    return;
  }

  // 4. Master HLS Stream (/live.m3u8?id=144)
  if (pathname === '/live.m3u8') {
    var channelId = parsedReq.query.id;
    var auth = loadAuth();
    if (!auth || !auth.authToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not logged in. Press RED button to login.' }));
      return;
    }

    var postForm = 'stream_type=Seek&channel_id=' + channelId;
    var playbackHeaders = assignHeaders(JIO_API_HEADERS, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'accesstoken': auth.authToken,
      'ssotoken': auth.ssoToken || '',
      'crmid': auth.sessionAttributes.user.subscriberId,
      'uniqueId': auth.sessionAttributes.user.unique,
      'userId': auth.sessionAttributes.user.uid,
      'deviceId': 'tizenbrew_jiotv_device_01'
    });

    requestUrl(
      'https://jiotvapi.media.jio.com/playback/apis/v1/geturl?langId=6',
      { method: 'POST', headers: playbackHeaders },
      postForm,
      function(err, pbRes) {
        if (err || !pbRes) {
          res.writeHead(502);
          res.end(String(err));
          return;
        }
        try {
          var pbData = JSON.parse(pbRes.body.toString());
          if (!pbData.result) {
            res.writeHead(502);
            res.end('No stream URL returned');
            return;
          }

          var streamUrl = pbData.result;
          var hdneaMatch = streamUrl.match(/(__hdnea__=[^&]+)/);
          if (hdneaMatch) {
            sessionCookies[channelId] = hdneaMatch[1];
          }

          requestUrl(
            streamUrl,
            {
              headers: assignHeaders(PLAYER_HEADERS, {
                'Cookie': sessionCookies[channelId] || ''
              })
            },
            null,
            function(err2, m3u8Res) {
              if (err2 || !m3u8Res) {
                res.writeHead(502);
                res.end(String(err2));
                return;
              }
              if (m3u8Res.headers['set-cookie']) {
                sessionCookies[channelId] = m3u8Res.headers['set-cookie'][0].split(';')[0];
              }
              var baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
              var rewritten = rewriteManifest(m3u8Res.body.toString(), baseUrl, channelId);
              res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
              res.end(rewritten);
            }
          );
        } catch (e) {
          res.writeHead(500);
          res.end(String(e));
        }
      }
    );
    return;
  }

  // 5. Proxy child .m3u8, .ts segments, and .key files
  if (pathname === '/proxy') {
    var target = parsedReq.query.url;
    var cid = parsedReq.query.cid;
    var cookie = sessionCookies[cid] || '';

    requestUrl(
      target,
      {
        headers: assignHeaders(PLAYER_HEADERS, {
          'Cookie': cookie
        })
      },
      null,
      function(err, proxyRes) {
        if (err || !proxyRes) {
          res.writeHead(502);
          res.end(String(err));
          return;
        }
        if (target.indexOf('.m3u8') !== -1) {
          var baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
          var rewritten = rewriteManifest(proxyRes.body.toString(), baseUrl, cid);
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
          res.end(rewritten);
          return;
        }
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': proxyRes.headers['content-type'] || 'video/MP2T'
        });
        res.end(proxyRes.body);
      }
    );
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1');