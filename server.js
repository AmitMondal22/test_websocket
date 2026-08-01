require('dotenv').config();

const path = require('path');
const fs = require('fs');
const fastify = require('fastify')({ logger: true });
const fastifyStatic = require('@fastify/static');
const fastifyWebsocket = require('@fastify/websocket');
const { v4: uuidv4 } = require('uuid');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DEVICES_FILE = path.join(__dirname, 'devices.json');

// ════════════════════════════════════════════════════════════
//  Persistent Device Storage (JSON file)
// ════════════════════════════════════════════════════════════

function readDevices() {
  try {
    if (!fs.existsSync(DEVICES_FILE)) {
      fs.writeFileSync(DEVICES_FILE, JSON.stringify([], null, 2));
      return [];
    }
    const data = fs.readFileSync(DEVICES_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    fastify.log.error('Error reading devices.json:', err);
    return [];
  }
}

function writeDevices(devices) {
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
  } catch (err) {
    fastify.log.error('Error writing devices.json:', err);
  }
}

// ════════════════════════════════════════════════════════════
//  In-Memory Connection Registries
// ════════════════════════════════════════════════════════════

// deviceId -> { socket, name, lastSeen }
const cameras = new Map();

// viewerId -> { socket, watchingCameraId }
const viewers = new Map();

// Reverse lookups for cleanup on disconnect
const socketToDevice = new Map(); // socket -> deviceId
const socketToViewer = new Map(); // socket -> viewerId

// ════════════════════════════════════════════════════════════
//  Helper Functions
// ════════════════════════════════════════════════════════════

// Get augmented device list with live online/offline status
function getAugmentedDevices() {
  const devices = readDevices();
  return devices.map(dev => ({
    ...dev,
    status: cameras.has(dev.id) ? 'online' : 'offline'
  }));
}

// Broadcast a JSON message to ALL registered viewers
function broadcastToViewers(message) {
  const payload = JSON.stringify(message);
  for (const [, viewer] of viewers.entries()) {
    if (viewer.socket.readyState === 1) {
      viewer.socket.send(payload);
    }
  }
}

// Get all viewer IDs currently watching a specific camera
function getViewersWatching(cameraId) {
  const result = [];
  for (const [viewerId, viewer] of viewers.entries()) {
    if (viewer.watchingCameraId === cameraId) {
      result.push({ viewerId, socket: viewer.socket });
    }
  }
  return result;
}

// ════════════════════════════════════════════════════════════
//  Static File Serving & Plugin Registration
// ════════════════════════════════════════════════════════════

fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
});

fastify.register(fastifyWebsocket);

// ════════════════════════════════════════════════════════════
//  REST API
// ════════════════════════════════════════════════════════════

fastify.get('/api/devices', async () => {
  return getAugmentedDevices();
});

// ════════════════════════════════════════════════════════════
//  WebSocket Route — Signaling + Binary Frame Relay
// ════════════════════════════════════════════════════════════

fastify.register(async function (fastifyInstance) {
  fastifyInstance.get('/ws', { websocket: true }, (socket, req) => {

    // ── Handle incoming messages (text = JSON signaling, binary = camera frames) ──
    socket.on('message', (rawData, isBinary) => {

      // ────────────────────────────────────────────
      //  BINARY: Camera sending a JPEG frame
      // ────────────────────────────────────────────
      if (isBinary) {
        const deviceId = socketToDevice.get(socket);
        if (!deviceId) return; // Not a registered camera

        // Relay this frame to all viewers watching this camera
        const watchers = getViewersWatching(deviceId);
        for (const watcher of watchers) {
          if (watcher.socket.readyState === 1) {
            watcher.socket.send(rawData, { binary: true });
          }
        }
        return;
      }

      // ────────────────────────────────────────────
      //  TEXT: JSON signaling messages
      // ────────────────────────────────────────────
      try {
        const message = JSON.parse(rawData.toString());

        switch (message.type) {

          // ─── ESP32 Camera Registration ───
          case 'register-camera': {
            const { deviceId, name } = message;
            if (!deviceId || !name) {
              socket.send(JSON.stringify({
                type: 'error',
                message: 'Missing required fields: deviceId, name'
              }));
              return;
            }

            // Store in memory
            cameras.set(deviceId, {
              socket,
              name,
              lastSeen: new Date().toISOString()
            });
            socketToDevice.set(socket, deviceId);

            // Persist to JSON
            const devices = readDevices();
            const idx = devices.findIndex(d => d.id === deviceId);
            if (idx > -1) {
              devices[idx].name = name;
              devices[idx].lastActive = new Date().toISOString();
            } else {
              devices.push({
                id: deviceId,
                name: name,
                lastActive: new Date().toISOString()
              });
            }
            writeDevices(devices);

            fastify.log.info(`Camera registered: ${name} (${deviceId})`);

            // Notify all viewers
            broadcastToViewers({
              type: 'devices-updated',
              devices: getAugmentedDevices()
            });

            socket.send(JSON.stringify({ type: 'registered', status: 'success' }));
            break;
          }

          // ─── Browser Viewer Registration ───
          case 'register-viewer': {
            const viewerId = uuidv4();
            viewers.set(viewerId, { socket, watchingCameraId: null });
            socketToViewer.set(socket, viewerId);

            fastify.log.info(`Viewer connected: ${viewerId}`);

            socket.send(JSON.stringify({
              type: 'viewer-registered',
              viewerId,
              devices: getAugmentedDevices()
            }));
            break;
          }

          // ─── Viewer requests to watch a camera stream ───
          case 'request-stream': {
            const viewerId = socketToViewer.get(socket);
            if (!viewerId) return;

            const { targetCameraId } = message;
            if (!targetCameraId) return;

            const cam = cameras.get(targetCameraId);
            if (!cam) {
              socket.send(JSON.stringify({
                type: 'stream-error',
                message: `Camera '${targetCameraId}' is not online.`
              }));
              return;
            }

            // Subscribe this viewer to the camera
            const viewer = viewers.get(viewerId);
            if (viewer) {
              viewer.watchingCameraId = targetCameraId;
            }

            fastify.log.info(`Viewer ${viewerId} started watching camera ${targetCameraId}`);

            socket.send(JSON.stringify({
              type: 'stream-started',
              cameraId: targetCameraId,
              cameraName: cam.name
            }));
            break;
          }

          // ─── Viewer stops watching ───
          case 'stop-stream': {
            const viewerId = socketToViewer.get(socket);
            if (!viewerId) return;

            const viewer = viewers.get(viewerId);
            if (viewer) {
              fastify.log.info(`Viewer ${viewerId} stopped watching camera ${viewer.watchingCameraId}`);
              viewer.watchingCameraId = null;
            }
            break;
          }

          // ─── Camera heartbeat ───
          case 'heartbeat': {
            const { deviceId } = message;
            if (deviceId && cameras.has(deviceId)) {
              cameras.get(deviceId).lastSeen = new Date().toISOString();
            }
            break;
          }

          default:
            fastify.log.warn(`Unknown message type: ${message.type}`);
        }
      } catch (err) {
        fastify.log.error('Failed to parse WebSocket message:', err);
      }
    });

    // ── Handle disconnect ──
    socket.on('close', () => {
      // Camera disconnected
      if (socketToDevice.has(socket)) {
        const deviceId = socketToDevice.get(socket);
        const cameraInfo = cameras.get(deviceId);
        cameras.delete(deviceId);
        socketToDevice.delete(socket);

        fastify.log.info(`Camera disconnected: ${cameraInfo?.name || deviceId}`);

        // Notify viewers watching this camera
        for (const [viewerId, viewer] of viewers.entries()) {
          if (viewer.watchingCameraId === deviceId && viewer.socket.readyState === 1) {
            viewer.watchingCameraId = null;
            viewer.socket.send(JSON.stringify({
              type: 'stream-ended',
              cameraId: deviceId,
              reason: 'Camera disconnected'
            }));
          }
        }

        // Broadcast updated device list
        broadcastToViewers({
          type: 'devices-updated',
          devices: getAugmentedDevices()
        });
      }

      // Viewer disconnected
      if (socketToViewer.has(socket)) {
        const viewerId = socketToViewer.get(socket);
        viewers.delete(viewerId);
        socketToViewer.delete(socket);
        fastify.log.info(`Viewer disconnected: ${viewerId}`);
      }
    });
  });
});

// ════════════════════════════════════════════════════════════
//  Start Server
// ════════════════════════════════════════════════════════════

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Server is listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
