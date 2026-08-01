const path = require('path');
const fs = require('fs');
const fastify = require('fastify')({ logger: true });
const fastifyStatic = require('@fastify/static');
const fastifyWebsocket = require('@fastify/websocket');
const { v4: uuidv4 } = require('uuid');

const DEVICES_FILE = path.join(__dirname, 'devices.json');

// Helper to read devices from JSON file
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

// Helper to write devices to JSON file
function writeDevices(devices) {
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
  } catch (err) {
    fastify.log.error('Error writing devices.json:', err);
  }
}

// In-memory mapping of active connections
// deviceId -> { socket, name, streamUrl, lastSeen }
const cameras = new Map();
// viewerId -> { socket }
const viewers = new Map();

// Reverse lookups for cleanup
const socketToDevice = new Map(); // socket -> deviceId
const socketToViewer = new Map(); // socket -> viewerId

// Serve static frontend files
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
});

// Register websocket support
fastify.register(fastifyWebsocket);

// Helper to get devices list with live status and stream URLs
function getAugmentedDevices() {
  const devices = readDevices();
  return devices.map(dev => {
    const cam = cameras.get(dev.id);
    return {
      ...dev,
      status: cam ? 'online' : 'offline',
      streamUrl: cam ? cam.streamUrl : null
    };
  });
}

// Helper to broadcast JSON messages to all registered viewers
function broadcastToViewers(message) {
  const payload = JSON.stringify(message);
  for (const [viewerId, viewer] of viewers.entries()) {
    if (viewer.socket.readyState === 1) { // OPEN
      viewer.socket.send(payload);
    }
  }
}

// REST Endpoint: Get all devices
fastify.get('/api/devices', async (request, reply) => {
  return getAugmentedDevices();
});

// WebSocket route - signaling only (no binary frames)
fastify.register(async function (fastifyInstance) {
  fastifyInstance.get('/ws', { websocket: true }, (socket, req) => {

    socket.on('message', (rawData) => {
      try {
        const message = JSON.parse(rawData.toString());

        switch (message.type) {

          // ─── ESP32-CAM registers itself ───
          case 'register-camera': {
            const { deviceId, name, streamUrl } = message;
            if (!deviceId || !name || !streamUrl) {
              socket.send(JSON.stringify({
                type: 'error',
                message: 'Missing required fields: deviceId, name, streamUrl'
              }));
              return;
            }

            // Register camera in memory with its MJPEG stream URL
            cameras.set(deviceId, {
              socket,
              name,
              streamUrl,
              lastSeen: new Date().toISOString()
            });
            socketToDevice.set(socket, deviceId);

            // Save to JSON storage
            const devices = readDevices();
            const existingIndex = devices.findIndex(d => d.id === deviceId);

            if (existingIndex > -1) {
              devices[existingIndex].name = name;
              devices[existingIndex].lastActive = new Date().toISOString();
            } else {
              devices.push({
                id: deviceId,
                name: name,
                lastActive: new Date().toISOString()
              });
            }
            writeDevices(devices);

            fastify.log.info(`Camera registered: ${name} (${deviceId}) stream at ${streamUrl}`);

            // Notify all viewers
            broadcastToViewers({
              type: 'devices-updated',
              devices: getAugmentedDevices()
            });

            socket.send(JSON.stringify({ type: 'registered', status: 'success' }));
            break;
          }

          // ─── Browser viewer registers itself ───
          case 'register-viewer': {
            const viewerId = uuidv4();
            viewers.set(viewerId, { socket });
            socketToViewer.set(socket, viewerId);

            fastify.log.info(`Viewer connected: ${viewerId}`);

            socket.send(JSON.stringify({
              type: 'viewer-registered',
              viewerId,
              devices: getAugmentedDevices()
            }));
            break;
          }

          default:
            fastify.log.warn(`Unknown message type: ${message.type}`);
        }
      } catch (err) {
        fastify.log.error('Failed to parse incoming socket message:', err);
      }
    });

    socket.on('close', () => {
      // Camera disconnected
      if (socketToDevice.has(socket)) {
        const deviceId = socketToDevice.get(socket);
        const cameraInfo = cameras.get(deviceId);
        cameras.delete(deviceId);
        socketToDevice.delete(socket);

        fastify.log.info(`Camera disconnected: ${cameraInfo?.name || deviceId}`);

        // Notify all viewers
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

// Start the server
const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    fastify.log.info(`Server is listening on http://localhost:3000`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
