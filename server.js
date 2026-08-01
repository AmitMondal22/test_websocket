require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const fastify = require('fastify')({ logger: true });
const fastifyStatic = require('@fastify/static');
const fastifyWebsocket = require('@fastify/websocket');
const { v4: uuidv4 } = require('uuid');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DEVICES_FILE = process.env.DEVICES_FILE
  ? path.resolve(__dirname, process.env.DEVICES_FILE)
  : path.join(__dirname, 'devices.json');


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

// Helper to clean IPv6 mapped addresses (e.g., ::ffff:192.168.0.108 -> 192.168.0.108)
function getCleanIp(rawIp) {
  if (!rawIp) return null;
  if (rawIp.startsWith('::ffff:')) {
    return rawIp.substring(7);
  }
  return rawIp;
}

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
      rawStreamUrl: cam ? cam.streamUrl : null,
      streamUrl: cam ? `/camera/${dev.id}` : null,
      proxyUrl: `/camera/${dev.id}`
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

// Stream proxy handler helper
function handleCameraStreamProxy(deviceId, request, reply) {
  const cam = cameras.get(deviceId);

  if (!cam || !cam.streamUrl) {
    const devices = readDevices();
    const dev = devices.find(d => d.id === deviceId);
    if (dev) {
      return reply.code(503).send({
        status: 'error',
        code: 'CAMERA_OFFLINE',
        message: `Camera '${deviceId}' (${dev.name}) is currently offline.`
      });
    }
    return reply.code(404).send({
      status: 'error',
      code: 'CAMERA_NOT_FOUND',
      message: `Camera '${deviceId}' does not exist.`
    });
  }

  // Circular dependency protection (prevent server fetching from its own proxy route)
  if (cam.streamUrl.includes(`/camera/${deviceId}`) || cam.streamUrl.includes(`:${PORT}/camera/`)) {
    return reply.code(500).send({
      status: 'error',
      code: 'CIRCULAR_PROXY_ERROR',
      message: `Camera '${deviceId}' registered a self-referential streamUrl (${cam.streamUrl}). Please configure ESP32 to register its local IP stream URL (e.g. http://192.168.0.108:81/stream).`
    });
  }

  const client = cam.streamUrl.startsWith('https') ? https : http;

  return new Promise((resolve) => {
    const proxyReq = client.get(cam.streamUrl, (camRes) => {
      reply.raw.writeHead(camRes.statusCode, camRes.headers);
      camRes.pipe(reply.raw);

      camRes.on('end', () => resolve());
      camRes.on('error', (err) => {
        fastify.log.error(`Proxy stream error for camera ${deviceId}:`, err);
        resolve();
      });
    });

    proxyReq.on('error', (err) => {
      fastify.log.error(`Failed to connect to camera ${deviceId} at ${cam.streamUrl}:`, err);
      if (!reply.raw.headersSent) {
        reply.code(502).send({
          status: 'error',
          code: 'CAMERA_STREAM_UNREACHABLE',
          message: `Unable to connect to camera stream at ${cam.streamUrl}`
        });
      }
      resolve();
    });

    request.raw.on('close', () => {
      proxyReq.destroy();
    });
  });
}

// REST Endpoint: Proxy live camera stream directly via /camera/:deviceId
fastify.get('/camera/:deviceId', async (request, reply) => {
  return handleCameraStreamProxy(request.params.deviceId, request, reply);
});

// REST Endpoint: Explicit proxy stream route /camera/:deviceId/stream
fastify.get('/camera/:deviceId/stream', async (request, reply) => {
  return handleCameraStreamProxy(request.params.deviceId, request, reply);
});

// REST Endpoint: Get single device details
fastify.get('/camera/:deviceId/info', async (request, reply) => {
  const { deviceId } = request.params;
  const devices = getAugmentedDevices();
  const dev = devices.find(d => d.id === deviceId);
  if (!dev) {
    return reply.code(404).send({ status: 'error', message: `Camera '${deviceId}' not found.` });
  }
  return dev;
});

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
            const { deviceId, name, streamUrl, localUrl } = message;
            if (!deviceId || !name) {
              socket.send(JSON.stringify({
                type: 'error',
                message: 'Missing required fields: deviceId, name'
              }));
              return;
            }

            const rawRemoteIp = req.socket?.remoteAddress || req.headers?.['x-forwarded-for'];
            const clientIp = getCleanIp(rawRemoteIp);

            // Determine target stream URL (where server fetches MJPEG from physical ESP32)
            let targetStreamUrl = localUrl || streamUrl;

            // Detect if streamUrl is self-referential (pointing back to this server's /camera/ route)
            const isSelfReferential = targetStreamUrl && (
              targetStreamUrl.includes(`/camera/${deviceId}`) ||
              targetStreamUrl.includes(`:${PORT}`)
            );

            if (!targetStreamUrl || isSelfReferential) {
              if (clientIp) {
                targetStreamUrl = `http://${clientIp}:81/stream`;
                fastify.log.warn(`Self-referential or missing streamUrl detected for camera ${deviceId}. Auto-resolved target stream URL to: ${targetStreamUrl}`);
              }
            }

            // Register camera in memory with resolved target MJPEG stream URL
            cameras.set(deviceId, {
              socket,
              name,
              streamUrl: targetStreamUrl,
              registeredStreamUrl: streamUrl,
              clientIp,
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
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Server is listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
