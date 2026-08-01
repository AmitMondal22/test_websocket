// WebSocket connection for signaling only (device list updates)
let ws = null;
let viewerId = null;
let currentCameraId = null;
let currentStreamUrl = null;

// Helper: Format ISO timestamp
function formatTime(isoString) {
  if (!isoString) return 'Never';
  const date = new Date(isoString);
  return date.toLocaleString();
}

// Connect to signaling server
const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
ws = new WebSocket(`${protocol}//${location.host}/ws`);

ws.onopen = () => {
  $('#server-status')
    .html('<i class="fa-solid fa-circle-dot me-1"></i>Server: Online')
    .removeClass('offline').addClass('online');

  // Register as a viewer
  ws.send(JSON.stringify({ type: 'register-viewer' }));
};

ws.onmessage = (event) => {
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

        // If the camera we are watching went offline, close the stream
        if (currentCameraId) {
          const device = msg.devices.find(d => d.id === currentCameraId);
          if (!device || device.status !== 'online') {
            closeStream();
            showToast('Camera went offline', 'warning');
          }
        }
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

// Fetch devices from REST API
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

// Render device cards
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
    const buttonHtml = isOnline
      ? `<button class="btn btn-primary-custom w-100 btn-watch"
           data-id="${dev.id}" data-name="${dev.name}" data-stream="${dev.streamUrl || ''}">
          <i class="fa-solid fa-circle-play me-1"></i>Watch Stream
         </button>`
      : `<button class="btn btn-secondary-custom w-100" disabled>
          <i class="fa-solid fa-video-slash me-1"></i>Offline
         </button>`;

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
    const streamUrl = $(this).data('stream');
    watchStream(id, name, streamUrl);
  });
}

// Start watching a camera's MJPEG stream
function watchStream(cameraId, cameraName, streamUrl) {
  if (currentCameraId) {
    closeStream();
  }

  if (!streamUrl) {
    showToast('No stream URL available for this camera', 'danger');
    return;
  }

  currentCameraId = cameraId;
  currentStreamUrl = streamUrl;

  $('#current-stream-name').html(
    `<i class="fa-solid fa-video me-2 text-violet"></i>Live: ${cameraName}`
  );
  $('#current-stream-id').text(`ID: ${cameraId}`);
  $('#stream-url-display').text(streamUrl);

  // Set the <img> src to the ESP32-CAM's MJPEG stream URL
  // The browser natively renders multipart/x-mixed-replace MJPEG streams in an <img> tag
  const imgEl = document.getElementById('remote-stream');
  imgEl.src = streamUrl;
  imgEl.style.display = 'block';
  $('#stream-error').addClass('d-none');

  // Reveal viewport
  $('#stream-viewport-container').removeClass('d-none');
  $('html, body').animate({
    scrollTop: $('#stream-viewport-container').offset().top - 20
  }, 500);
}

// Close the active stream
function closeStream() {
  const imgEl = document.getElementById('remote-stream');
  imgEl.removeAttribute('src');
  imgEl.style.display = 'none';

  $('#stream-viewport-container').addClass('d-none');
  currentCameraId = null;
  currentStreamUrl = null;
}

// Simple toast notification
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

// Bind UI Controls
$('#btn-close-stream').on('click', () => closeStream());
$('#btn-refresh-devices').on('click', () => refreshDevicesList());

// Initial load
refreshDevicesList();
