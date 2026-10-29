const API_BASE = 'http://127.0.0.1:4567';
const COLS = 6;

let allChannels = [];
let filteredChannels = [];
let focusIndex = 0;
let isPlaying = false;
let hlsInstance = null;

// Language Filter Cycle (6 = English, 1 = Hindi, 5 = Bengali, 0 = All)
const LANGUAGES = [
  { id: 0, name: 'All Languages' },
  { id: 5, name: 'Bengali' },
  { id: 1, name: 'Hindi' },
  { id: 6, name: 'English' }
];
let langIdx = 0;

// Number Pad Direct Channel Buffer
let numBuffer = '';
let numTimer = null;

// function init() {
//   fetch(API_BASE + '/channels')
//     .then(function(r) { return r.json(); })
//     .then(function(data) {
//       allChannels = data.result || [];
//       filteredChannels = allChannels.slice(0, 300);
//       renderGrid();
//     })
//     .catch(function(err) {
//       document.getElementById('grid').innerHTML = '<h2>Connecting to local Node.js service...</h2>';
//       setTimeout(init, 2000);
//     });
// }

function init() {
  var grid = document.getElementById('grid');
  grid.innerHTML = '<h2>Connecting to local Node.js service on 127.0.0.1:4567...</h2>';

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
    .catch(function(err) {
      // Show exact error on TV screen + try direct catalog fetch as fallback
      grid.innerHTML =
        '<div style="grid-column: 1 / -1; background:#1e293b; padding:20px; border-radius:8px;">' +
        '<h3 style="color:#f87171; margin-bottom:8px;">Local Service Status: ' + err.message + '</h3>' +
        '<p style="color:#94a3b8; font-size:15px;">Origin: ' + window.location.protocol + '//' + window.location.host + ' | Trying direct catalog fallback...</p>' +
        '</div>';

      // Fallback: Fetch public channel list directly if CORS permits
      fetch('https://jiotvapi.cdn.jio.com/apis/v3.0/getMobileChannelList/get/?langId=6&os=android&devicetype=phone&usertype=JIO&version=330')
        .then(function(r2) { return r2.json(); })
        .then(function(data2) {
          allChannels = data2.result || [];
          filteredChannels = allChannels.slice(0, 300);
          renderGrid();
        })
        .catch(function() {
          setTimeout(init, 3000);
        });
    });
}

function renderGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  filteredChannels.forEach(function(ch, idx) {
    const card = document.createElement('div');
    card.className = 'card' + (idx === focusIndex ? ' focused' : '');
    card.id = 'card-' + idx;
    const logo = 'https://jiotv.catchup.cdn.jio.com/dare_images/images/' + ch.logoUrl;

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
  const oldCard = document.getElementById('card-' + focusIndex);
  if (oldCard) oldCard.classList.remove('focused');

  focusIndex = Math.max(0, Math.min(newIndex, filteredChannels.length - 1));
  const newCard = document.getElementById('card-' + focusIndex);
  if (newCard) newCard.classList.add('focused');

  scrollToFocused();
}

function scrollToFocused() {
  const card = document.getElementById('card-' + focusIndex);
  const box = document.getElementById('scroll-box');
  if (card && box) {
    const row = Math.floor(focusIndex / COLS);
    box.scrollTop = Math.max(0, (row - 1) * 185);
  }
}

function playChannel(index) {
  const ch = filteredChannels[index];
  if (!ch) return;

  isPlaying = true;
  document.getElementById('player-overlay').style.display = 'block';
  showOSD('CH ' + (index + 1) + ' - ' + ch.channel_name);

  const video = document.getElementById('tv-video');
  const streamUrl = API_BASE + '/live.m3u8?id=' + ch.channel_id;

  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  if (window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 30
    });
    hlsInstance.loadSource(streamUrl);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
      video.play();
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = streamUrl;
    video.play();
  }
}

function stopPlayer() {
  isPlaying = false;
  const video = document.getElementById('tv-video');
  video.pause();
  video.removeAttribute('src');
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  document.getElementById('player-overlay').style.display = 'none';
}

function showOSD(text) {
  const osd = document.getElementById('osd-banner');
  osd.textContent = text;
  osd.style.display = 'block';
  clearTimeout(window.osdTimeout);
  window.osdTimeout = setTimeout(function() {
    osd.style.display = 'none';
  }, 3500);
}

function cycleLanguage() {
  langIdx = (langIdx + 1) % LANGUAGES.length;
  const targetLang = LANGUAGES[langIdx];
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

function handleNumberKey(digit) {
  numBuffer += String(digit);
  const numOsd = document.getElementById('num-osd');
  numOsd.textContent = 'CH ' + numBuffer;
  numOsd.style.display = 'block';

  clearTimeout(numTimer);
  numTimer = setTimeout(function() {
    numOsd.style.display = 'none';
    const targetIdx = parseInt(numBuffer, 10) - 1;
    numBuffer = '';
    if (targetIdx >= 0 && targetIdx < filteredChannels.length) {
      updateFocus(targetIdx);
      if (isPlaying) playChannel(targetIdx);
    }
  }, 1500);
}

// Remote Key Handler
window.addEventListener('keydown', function(e) {
  const code = e.keyCode;

  // Number Keys (0-9 are keyCodes 48 to 57)
  if (code >= 48 && code <= 57) {
    handleNumberKey(code - 48);
    return;
  }

  // When Fullscreen Video is Playing
  if (isPlaying) {
    if (code === 10009 || code === 27 || code === 8) { // Tizen Back / Esc
      e.preventDefault();
      stopPlayer();
    } else if (code === 427 || code === 38) { // Channel Up or D-Pad Up
      updateFocus(focusIndex + 1);
      playChannel(focusIndex);
    } else if (code === 428 || code === 40) { // Channel Down or D-Pad Down
      updateFocus(focusIndex - 1);
      playChannel(focusIndex);
    }
    return;
  }

  // Grid Navigation Mode
  switch (code) {
    case 37: // Left
      updateFocus(focusIndex - 1);
      break;
    case 39: // Right
      updateFocus(focusIndex + 1);
      break;
    case 38: // Up
      updateFocus(focusIndex - COLS);
      break;
    case 40: // Down
      updateFocus(focusIndex + COLS);
      break;
    case 13: // Enter / OK
      playChannel(focusIndex);
      break;
    case 404: // Green Button: Filter Language (All / Bengali / Hindi / English)
      cycleLanguage();
      break;
    case 403: // Red Button: Quick OTP Login Prompt
      triggerLoginPrompt();
      break;
  }
});

function triggerLoginPrompt() {
  const phone = prompt('Enter 10-digit Jio Mobile Number:');
  if (!phone) return;
  fetch(API_BASE + '/login/send-otp', {
    method: 'POST',
    body: JSON.stringify({ phone: phone })
  }).then(function() {
    const otp = prompt('Enter the OTP received on ' + phone + ':');
    if (!otp) return;
    return fetch(API_BASE + '/login/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ phone: phone, otp: otp })
    });
  }).then(function(r) {
    if (r && r.status === 200) alert('Login Successful! Tokens saved on TV.');
    else alert('OTP Verification failed.');
  });
}

window.onload = init;