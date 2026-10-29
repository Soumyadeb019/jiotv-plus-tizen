var API_BASE = 'http://127.0.0.1:4567';
var COLS = 6;

var allChannels = [];
var filteredChannels = [];
var focusIndex = 0;
var isPlaying = false;
var hlsInstance = null;
var serviceOnline = false;

// Login Modal State
var loginOpen = false;
var loginStep = 1; // 1 = Phone, 2 = OTP
var savedPhone = '';
var inputBuffer = '';

var LANGUAGES = [
  { id: 0, name: 'All Languages' },
  { id: 5, name: 'Bengali' },
  { id: 1, name: 'Hindi' },
  { id: 6, name: 'English' }
];
var langIdx = 0;

var numBuffer = '';
var numTimer = null;

function checkServiceHealth() {
  var badge = document.getElementById('service-badge');
  fetch(API_BASE + '/ping')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      serviceOnline = true;
      badge.textContent = 'Service: Online (' + (data.node || 'Node') + ')';
      badge.style.background = '#166534';
    })
    .catch(function() {
      serviceOnline = false;
      badge.textContent = 'Service: Offline (Port 4567 unreachable)';
      badge.style.background = '#991b1b';
    });
}

function init() {
  checkServiceHealth();
  var grid = document.getElementById('grid');
  grid.innerHTML = '<h2>Loading channels...</h2>';

  fetch(API_BASE + '/channels')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      allChannels = data.result || [];
      filteredChannels = allChannels.slice(0, 300);
      renderGrid();
    })
    .catch(function() {
      // Fallback: load channel catalog directly
      fetch('https://jiotvapi.cdn.jio.com/apis/v3.0/getMobileChannelList/get/?langId=6&os=android&devicetype=phone&usertype=JIO&version=330')
        .then(function(r2) { return r2.json(); })
        .then(function(data2) {
          allChannels = data2.result || [];
          filteredChannels = allChannels.slice(0, 300);
          renderGrid();
        })
        .catch(function(err2) {
          grid.innerHTML = '<h2>Failed to load catalog: ' + err2.message + '</h2>';
        });
    });
}

function renderGrid() {
  var grid = document.getElementById('grid');
  grid.innerHTML = '';

  filteredChannels.forEach(function(ch, idx) {
    var card = document.createElement('div');
    card.className = 'card' + (idx === focusIndex ? ' focused' : '');
    card.id = 'card-' + idx;
    var logo = 'https://jiotv.catchup.cdn.jio.com/dare_images/images/' + ch.logoUrl;

    card.innerHTML =
      '<div class="card-num">CH ' + (idx + 1) + '</div>' +
      '<img src="' + logo + '" alt="">' +
      '<div class="card-title">' + ch.channel_name + '</div>';
    grid.appendChild(card);
  });
  scrollToFocused();
}

function updateFocus(newIndex) {
  if (filteredChannels.length === 0) return;
  var oldCard = document.getElementById('card-' + focusIndex);
  if (oldCard) oldCard.classList.remove('focused');

  focusIndex = Math.max(0, Math.min(newIndex, filteredChannels.length - 1));
  var newCard = document.getElementById('card-' + focusIndex);
  if (newCard) newCard.classList.add('focused');

  scrollToFocused();
}

function scrollToFocused() {
  var card = document.getElementById('card-' + focusIndex);
  var box = document.getElementById('scroll-box');
  if (card && box) {
    var row = Math.floor(focusIndex / COLS);
    box.scrollTop = Math.max(0, (row - 1) * 180);
  }
}

function setPlayerStatus(htmlText, hideAfterMs) {
  var st = document.getElementById('player-status');
  st.innerHTML = htmlText;
  st.style.display = 'block';
  clearTimeout(window.statusTimer);
  if (hideAfterMs) {
    window.statusTimer = setTimeout(function() {
      st.style.display = 'none';
    }, hideAfterMs);
  }
}

function playChannel(index) {
  var ch = filteredChannels[index];
  if (!ch) return;

  isPlaying = true;
  document.getElementById('player-overlay').style.display = 'block';
  showOSD('CH ' + (index + 1) + ' - ' + ch.channel_name);
  setPlayerStatus('Connecting to stream for <b>' + ch.channel_name + '</b>...', 0);

  var video = document.getElementById('tv-video');
  var streamUrl = API_BASE + '/live.m3u8?id=' + ch.channel_id;

  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  // First pre-check the endpoint so we can show readable HTTP errors on screen
  fetch(streamUrl)
    .then(function(r) {
      if (r.status === 401) {
        throw new Error('Not Logged In (HTTP 401).<br><br>Press <b>BACK</b>, then press the <b>RED Button</b> on your remote to log in with OTP.');
      }
      if (!r.ok) {
        return r.text().then(function(t) {
          throw new Error('Stream Error (HTTP ' + r.status + '): ' + t);
        });
      }
      // Stream manifest is valid! Hand off to HLS player
      startHlsPlayback(video, streamUrl);
    })
    .catch(function(err) {
      var msg = err.message || String(err);
      if (msg.indexOf('Failed to fetch') !== -1 || msg.indexOf('NetworkError') !== -1) {
        msg = 'Cannot reach local Node proxy on 127.0.0.1:4567.<br><br>Make sure service.js is updated and jsDelivr cache is purged.';
      }
      setPlayerStatus('<span style="color:#f87171;">Playback Failed</span><br><br>' + msg + '<br><br><span style="font-size:15px; color:#9ca3af;">Press BACK to return to channels</span>', 0);
    });
}

function startHlsPlayback(video, streamUrl) {
  if (window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls({
      enableWorker: false, // Safer on older Tizen Chromium
      lowLatencyMode: false
    });
    hlsInstance.loadSource(streamUrl);
    hlsInstance.attachMedia(video);

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
      setPlayerStatus('Playing...', 1000);
      video.play();
    });

    hlsInstance.on(Hls.Events.ERROR, function(event, data) {
      if (data.fatal) {
        setPlayerStatus(
          '<span style="color:#f87171;">HLS Error: ' + data.details + '</span><br>' +
          'Type: ' + data.type + '<br><br>Press BACK to exit',
          0
        );
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = streamUrl;
    video.onloadedmetadata = function() {
      setPlayerStatus('Playing...', 1000);
      video.play();
    };
  }
}

function stopPlayer() {
  isPlaying = false;
  var video = document.getElementById('tv-video');
  video.pause();
  video.removeAttribute('src');
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  document.getElementById('player-overlay').style.display = 'none';
}

function showOSD(text) {
  var osd = document.getElementById('osd-banner');
  osd.textContent = text;
  osd.style.display = 'block';
  clearTimeout(window.osdTimeout);
  window.osdTimeout = setTimeout(function() {
    osd.style.display = 'none';
  }, 3500);
}

function cycleLanguage() {
  langIdx = (langIdx + 1) % LANGUAGES.length;
  var targetLang = LANGUAGES[langIdx];
  document.getElementById('filter-label').textContent = targetLang.name;

  if (targetLang.id === 0) {
    filteredChannels = allChannels.slice(0, 300);
  } else {
    filteredChannels = allChannels.filter(function(c) {
      return c.channelLanguageId === targetLang.id;
    });
  }
  focusIndex = 0;
  renderGrid();
}

// On-Screen Remote Login Modal Functions
function openLoginModal() {
  loginOpen = true;
  loginStep = 1;
  inputBuffer = '';
  document.getElementById('login-title').textContent = 'Jio Login - Step 1 of 2';
  document.getElementById('login-sub').textContent = 'Use your remote 0-9 number keys to enter your 10-digit Jio number:';
  document.getElementById('login-input').textContent = '_';
  document.getElementById('login-modal').style.display = 'flex';
}

function closeLoginModal() {
  loginOpen = false;
  document.getElementById('login-modal').style.display = 'none';
}

function submitLoginStep() {
  var titleEl = document.getElementById('login-title');
  var subEl = document.getElementById('login-sub');
  var inputEl = document.getElementById('login-input');

  if (loginStep === 1) {
    if (inputBuffer.length !== 10) {
      subEl.innerHTML = '<span style="color:#f87171;">Please enter exactly 10 digits!</span>';
      return;
    }
    savedPhone = inputBuffer;
    subEl.textContent = 'Sending OTP to ' + savedPhone + '...';

    fetch(API_BASE + '/login/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: savedPhone })
    })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        loginStep = 2;
        inputBuffer = '';
        titleEl.textContent = 'Jio Login - Step 2 of 2';
        subEl.textContent = 'Enter the 6-digit OTP sent to ' + savedPhone + ':';
        inputEl.textContent = '_';
      })
      .catch(function(err) {
        subEl.innerHTML = '<span style="color:#f87171;">Failed to send OTP: ' + err.message + '</span>';
      });
  } else if (loginStep === 2) {
    var otpCode = inputBuffer;
    subEl.textContent = 'Verifying OTP...';

    fetch(API_BASE + '/login/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: savedPhone, otp: otpCode })
    })
      .then(function(r) {
        if (!r.ok) throw new Error('Invalid OTP or HTTP ' + r.status);
        titleEl.textContent = 'Login Successful!';
        subEl.innerHTML = '<span style="color:#4ade80;">Tokens saved! Closing in 2 seconds...</span>';
        setTimeout(closeLoginModal, 2000);
      })
      .catch(function(err) {
        subEl.innerHTML = '<span style="color:#f87171;">Verification Failed: ' + err.message + '</span>';
      });
  }
}

function handleNumberKey(digit) {
  if (loginOpen) {
    if (inputBuffer.length < 10) {
      inputBuffer += String(digit);
      document.getElementById('login-input').textContent = inputBuffer;
    }
    return;
  }

  numBuffer += String(digit);
  var numOsd = document.getElementById('num-osd');
  numOsd.textContent = 'CH ' + numBuffer;
  numOsd.style.display = 'block';

  clearTimeout(numTimer);
  numTimer = setTimeout(function() {
    numOsd.style.display = 'none';
    var targetIdx = parseInt(numBuffer, 10) - 1;
    numBuffer = '';
    if (targetIdx >= 0 && targetIdx < filteredChannels.length) {
      updateFocus(targetIdx);
      if (isPlaying) playChannel(targetIdx);
    }
  }, 1500);
}

window.addEventListener('keydown', function(e) {
  var code = e.keyCode;

  // Number Keys (0-9 are keyCodes 48 to 57)
  if (code >= 48 && code <= 57) {
    handleNumberKey(code - 48);
    return;
  }

  // Handle Login Modal Keys
  if (loginOpen) {
    if (code === 10009 || code === 27) { // Back
      e.preventDefault();
      closeLoginModal();
    } else if (code === 37 || code === 8) { // Left Arrow or Backspace deletes last digit
      inputBuffer = inputBuffer.slice(0, -1);
      document.getElementById('login-input').textContent = inputBuffer || '_';
    } else if (code === 13) { // Enter submits
      submitLoginStep();
    }
    return;
  }

  // Handle Video Player Keys
  if (isPlaying) {
    if (code === 10009 || code === 27 || code === 8) {
      e.preventDefault();
      stopPlayer();
    } else if (code === 427 || code === 38) {
      updateFocus(focusIndex + 1);
      playChannel(focusIndex);
    } else if (code === 428 || code === 40) {
      updateFocus(focusIndex - 1);
      playChannel(focusIndex);
    }
    return;
  }

  // Grid Navigation Keys
  switch (code) {
    case 37:
      updateFocus(focusIndex - 1);
      break;
    case 39:
      updateFocus(focusIndex + 1);
      break;
    case 38:
      updateFocus(focusIndex - COLS);
      break;
    case 40:
      updateFocus(focusIndex + COLS);
      break;
    case 13:
      playChannel(focusIndex);
      break;
    case 404: // Green Button
      cycleLanguage();
      break;
    case 403: // Red Button
      openLoginModal();
      break;
  }
});

window.onload = init;