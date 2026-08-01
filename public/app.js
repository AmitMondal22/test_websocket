// ════════════════════════════════════════════════════════════
//  ESP32-CAM WebSocket Binary Streaming — Viewer Dashboard
// ════════════════════════════════════════════════════════════

let ws = null;
let viewerId = null;
let currentCameraId = null;

// FPS tracking
let frameCount = 0;
let lastFpsUpdate = 0;
let currentFps = 0;

// Canvas rendering
const canvas = document.getElementById('remote-stream');
const ctx = canvas.getContext('2d');

// ════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════

function formatTime(isoString) {
  if (!isoString) return 'Never';
  const date = new Date(isoString);
  return date.toLocaleString();
}

// Render a JPEG blob onto the canvas
function renderFrame(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();

  img.onload = () => {
    // Resize canvas to match frame dimensions (only if changed)
    if (canvas.width !== img.width || canvas.height !== img.height) {
      canvas.width = img.width;
      canvas.height = img.height;
    }

    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    // FPS counter
    frameCount++;
    const now = performance.now();
    if (now - lastFpsUpdate >= 1000) {
      currentFps = frameCount;
      frameCount = 0;
      lastFpsUpdate = now;
      $('#stream-fps-display').text(`${currentFps} FPS`);
    }
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
  };

  img.src = url;
}

// ════════════════════════════════════════════════════════════
//  WebSocket Connection
// ════════════════════════════════════════════════════════════

const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
ws = new WebSocket(`${protocol}//${location.host}/ws`);

// Receive binary frames as Blob
ws.binaryType = 'blob';

ws.onopen = () => {
  $('#server-status')
    .html('<i class="fa-solid fa-circle-dot me-1"></i>Server: Online')
    .removeClass('offline').addClass('online');

  // Register as a viewer
  ws.send(JSON.stringify({ type: 'register-viewer' }));
};

ws.onmessage = (event) => {
  // ── Binary frame from camera ──
  if (event.data instanceof Blob) {
    if (!currentCameraId) return; // Not watching anything

    canvas.style.display = 'block';
    $('#stream-placeholder').addClass('d-none');

    renderFrame(event.data);
    return;
  }

  // ── Text JSON signaling message ──
  try {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'viewer-registered':
        viewerId = msg.viewerId;
        console.log(`Registered as viewer: ${viewerId}`);
        renderDevicesGrid(msg.devices);
        break;

      case 'devices-updated':
        console.log('Devices list updated');
        renderDevicesGrid(msg.devices);

        // If camera we are watching went offline, close stream
        if (currentCameraId) {
          const device = msg.devices.find(d => d.id === currentCameraId);
          if (!device || device.status !== 'online') {
            closeStream();
            showToast('Camera went offline', 'warning');
          }
        }
        break;

      case 'stream-started':
        console.log(`Stream started for camera: ${msg.cameraName}`);
        showToast(`Watching: ${msg.cameraName}`, 'success');
        break;

      case 'stream-ended':
        console.log(`Stream ended: ${msg.reason}`);
        closeStream();
        showToast(`Stream ended: ${msg.reason}`, 'warning');
        break;

      case 'stream-error':
        console.error(`Stream error: ${msg.message}`);
        showToast(msg.message, 'danger');
        break;
    }
  } catch (err) {
    console.error('Error handling message:', err);
  }
};

ws.onclose = () => {
  $('#server-status')
    .html('<i class="fa-solid fa-circle-dot me-1"></i>Server: Offline')
    .removeClass('online').addClass('offline');
};

// ════════════════════════════════════════════════════════════
//  Device List
// ════════════════════════════════════════════════════════════

async function refreshDevicesList() {
  $('#devices-loading').removeClass('d-none');
  $('#devices-grid').find('.camera-card-col').remove();
  $('#no-cameras-alert').addClass('d-none');

  try {
    const res = await fetch('/api/devices');
    const devices = await res.json();
    renderDevicesGrid(devices);
  } catch (err) {
    console.error('Error fetching devices:', err);
  }
}

function renderDevicesGrid(devices) {
  $('#devices-loading').addClass('d-none');
  $('#devices-grid').find('.camera-card-col').remove();

  if (!devices || devices.length === 0) {
    $('#no-cameras-alert').removeClass('d-none');
    return;
  }

  $('#no-cameras-alert').addClass('d-none');

  devices.forEach(dev => {
    const isOnline = dev.status === 'online';
    const isWatching = currentCameraId === dev.id;

    let buttonHtml;
    if (isWatching) {
      buttonHtml = `<button class="btn btn-danger w-100 btn-stop-watch" data-id="${dev.id}">
          <i class="fa-solid fa-circle-stop me-1"></i>Stop Watching
         </button>`;
    } else if (isOnline) {
      buttonHtml = `<button class="btn btn-primary-custom w-100 btn-watch"
           data-id="${dev.id}" data-name="${dev.name}">
          <i class="fa-solid fa-circle-play me-1"></i>Watch Stream
         </button>`;
    } else {
      buttonHtml = `<button class="btn btn-secondary-custom w-100" disabled>
          <i class="fa-solid fa-video-slash me-1"></i>Offline
         </button>`;
    }

    const card = $(`
      <div class="col camera-card-col">
        <div class="card camera-card glass-panel h-100">
          <div class="card-body d-flex flex-column justify-content-between">
            <div>
              <div class="d-flex justify-content-between align-items-center mb-3">
                <span class="status-pill ${isOnline ? 'online' : 'offline'}">
                  <span class="pulse-indicator ${isOnline ? '' : 'offline'}"></span>${dev.status}
                </span>
                <small class="text-secondary font-monospace" style="font-size: 0.7rem;">${dev.id}</small>
              </div>
              <h5 class="card-title text-light mb-1">${dev.name}</h5>
              <p class="card-text text-secondary small mb-3">
                <i class="fa-regular fa-clock me-1"></i>Last Active: ${formatTime(dev.lastActive)}
              </p>
            </div>
            <div class="mt-2">
              ${buttonHtml}
            </div>
          </div>
        </div>
      </div>
    `);

    $('#devices-grid').append(card);
  });

  // Bind watch button clicks
  $('.btn-watch').off('click').on('click', function () {
    const id = $(this).data('id');
    const name = $(this).data('name');
    watchStream(id, name);
  });

  // Bind stop-watch button clicks
  $('.btn-stop-watch').off('click').on('click', function () {
    closeStream();
  });
}

// ════════════════════════════════════════════════════════════
//  Stream Control
// ════════════════════════════════════════════════════════════

function watchStream(cameraId, cameraName) {
  if (currentCameraId) {
    closeStream();
  }

  currentCameraId = cameraId;

  // Reset FPS tracking
  frameCount = 0;
  lastFpsUpdate = performance.now();
  currentFps = 0;

  $('#current-stream-name').html(
    `<i class="fa-solid fa-video me-2 text-violet"></i>Live: ${cameraName}`
  );
  $('#current-stream-id').text(`ID: ${cameraId}`);
  $('#stream-fps-display').text('Connecting...');

  // Show placeholder until first frame arrives
  canvas.style.display = 'none';
  $('#stream-placeholder').removeClass('d-none');

  // Reveal viewport
  $('#stream-viewport-container').removeClass('d-none');
  $('html, body').animate({
    scrollTop: $('#stream-viewport-container').offset().top - 20
  }, 500);

  // Tell server to start relaying frames
  ws.send(JSON.stringify({
    type: 'request-stream',
    targetCameraId: cameraId
  }));

  // Re-render device list to show "Stop Watching" button
  refreshDevicesList();
}

function closeStream() {
  // Tell server to stop relaying frames
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop-stream' }));
  }

  canvas.style.display = 'none';
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  $('#stream-viewport-container').addClass('d-none');
  $('#stream-fps-display').text('');

  currentCameraId = null;

  // Re-render device list to show "Watch Stream" button
  refreshDevicesList();
}

// ════════════════════════════════════════════════════════════
//  Toast Notifications
// ════════════════════════════════════════════════════════════

function showToast(message, type) {
  const toast = $(`
    <div class="toast-notification ${type}">
      <i class="fa-solid fa-circle-exclamation me-2"></i>${message}
    </div>
  `);
  $('body').append(toast);
  setTimeout(() => toast.addClass('show'), 10);
  setTimeout(() => {
    toast.removeClass('show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ════════════════════════════════════════════════════════════
//  UI Bindings
// ════════════════════════════════════════════════════════════

$('#btn-close-stream').on('click', () => closeStream());
$('#btn-refresh-devices').on('click', () => refreshDevicesList());

// Initial load
refreshDevicesList();
