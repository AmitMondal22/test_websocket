# ESP32-CAM Streaming Setup Guide

This guide explains how to set up your **ESP32-CAM** (AI-Thinker board) to stream video to the dashboard.

## How It Works

The ESP32-CAM does two things:
1. **Runs its own HTTP MJPEG server** on port `81` — this streams live JPEG frames over HTTP.
2. **Connects to the Fastify signaling server** via WebSocket — this registers the camera's name, device ID, and stream URL so the dashboard knows about it.

The browser dashboard then loads the stream **directly from the ESP32-CAM's HTTP server** using a simple `<img>` tag. No WebRTC, no binary WebSocket relay.

```
ESP32-CAM                        Fastify Server (:3000)           Browser
  |                                    |                             |
  |--- WebSocket: register-camera ---->|                             |
  |    (deviceId, name, streamUrl)     |                             |
  |                                    |--- WS: devices-updated --->|
  |                                    |    (includes streamUrl)     |
  |                                    |                             |
  |<============ HTTP MJPEG stream (port 81) ========================|
  |    (browser connects directly to ESP32's /stream endpoint)       |
```

---

## 1. Arduino Code for ESP32-CAM

### Dependencies
Install via Arduino Library Manager:
* **WebSocketsClient** by Markus Sattler

### Board Setup
* Board: **AI Thinker ESP32-CAM**
* Partition Scheme: **Huge APP (3MB No OTA)**

### Sketch: `ESP32_CAM_Stream.ino`

```cpp
#include "esp_camera.h"
#include "esp_http_server.h"
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ─── CONFIGURATION ───
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// Your computer's IP address running the Fastify server
const char* signaling_host = "192.168.29.210";
const int   signaling_port = 3000;

const char* device_id   = "esp32_cam_01";
const char* device_name = "ESP32 Driveway Cam";
const int   stream_port = 81;  // HTTP MJPEG stream port

// ─── ESP32-CAM Pin Definitions (AI-Thinker Model) ───
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

WebSocketsClient webSocket;
httpd_handle_t stream_httpd = NULL;

// ─── MJPEG Stream Handler ───
#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t *req) {
  camera_fb_t *fb = NULL;
  esp_err_t res = ESP_OK;
  char part_buf[64];

  res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;

  // Disable caching
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Camera capture failed");
      res = ESP_FAIL;
      break;
    }

    size_t hlen = snprintf(part_buf, 64, _STREAM_PART, fb->len);
    res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
    if (res == ESP_OK)
      res = httpd_resp_send_chunk(req, part_buf, hlen);
    if (res == ESP_OK)
      res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);

    esp_camera_fb_return(fb);

    if (res != ESP_OK) break;
  }
  return res;
}

void startStreamServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = stream_port;

  httpd_uri_t stream_uri = {
    .uri       = "/stream",
    .method    = HTTP_GET,
    .handler   = stream_handler,
    .user_ctx  = NULL
  };

  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
    Serial.printf("MJPEG stream server started on port %d\n", stream_port);
  }
}

// ─── WebSocket Events (Signaling Only) ───
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from signaling server");
      break;

    case WStype_CONNECTED: {
      Serial.printf("[WS] Connected to signaling server\n");

      // Build the stream URL using our local IP
      String streamUrl = "http://" + WiFi.localIP().toString() + ":" + String(stream_port) + "/stream";

      // Register with signaling server
      String regMsg = "{\"type\":\"register-camera\","
                      "\"deviceId\":\"" + String(device_id) + "\","
                      "\"name\":\"" + String(device_name) + "\","
                      "\"streamUrl\":\"" + streamUrl + "\"}";

      webSocket.sendTXT(regMsg);
      Serial.printf("[WS] Registered as: %s, stream at: %s\n", device_name, streamUrl.c_str());
      break;
    }

    case WStype_TEXT:
      Serial.printf("[WS] Server message: %s\n", payload);
      break;

    default:
      break;
  }
}

// ─── Camera Init ───
void initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;     // 640x480
    config.jpeg_quality = 12;               // 0-63 (lower = better)
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_QVGA;    // 320x240
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    return;
  }
  Serial.println("Camera initialized successfully");
}

// ─── Setup ───
void setup() {
  Serial.begin(115200);

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi connected. IP: ");
  Serial.println(WiFi.localIP());

  // Initialize camera
  initCamera();

  // Start the MJPEG HTTP stream server on port 81
  startStreamServer();

  // Connect to signaling server via WebSocket (text-only, for registration)
  webSocket.begin(signaling_host, signaling_port, "/ws");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

// ─── Loop ───
void loop() {
  webSocket.loop();
}
```

---

## 2. Configuration Checklist

Before uploading to your ESP32-CAM:

1. **Set your WiFi credentials**:
   ```cpp
   const char* ssid = "YOUR_WIFI_SSID";
   const char* password = "YOUR_WIFI_PASSWORD";
   ```

2. **Set your computer's IP** (where the Fastify server runs):
   ```cpp
   const char* signaling_host = "192.168.29.210";  // Run `ipconfig` on your PC to find this
   ```

3. **Set a unique device ID and name** for each ESP32-CAM:
   ```cpp
   const char* device_id   = "esp32_cam_01";
   const char* device_name = "ESP32 Driveway Cam";
   ```

---

## 3. Testing

1. Upload the sketch to your ESP32-CAM.
2. Open Arduino Serial Monitor at 115200 baud.
3. You should see:
   ```
   WiFi connected. IP: 192.168.29.XXX
   Camera initialized successfully
   MJPEG stream server started on port 81
   [WS] Connected to signaling server
   [WS] Registered as: ESP32 Driveway Cam, stream at: http://192.168.29.XXX:81/stream
   ```
4. Open `http://localhost:3000` in your browser — the camera should appear as **Online**.
5. Click **Watch Stream** to view the live MJPEG feed.

> **Note**: The browser and ESP32-CAM must be on the **same local network** for the browser to directly reach the ESP32's HTTP stream URL.

---

## 4. Troubleshooting

| Problem | Solution |
|---------|----------|
| Camera shows "Online" but stream doesn't load | Verify ESP32's IP is reachable from your browser. Try opening `http://ESP32_IP:81/stream` directly in a new tab. |
| Camera doesn't appear on dashboard | Check Serial Monitor for WebSocket connection errors. Verify `signaling_host` IP matches your PC. |
| Stream is slow or choppy | Reduce resolution: change `FRAMESIZE_VGA` to `FRAMESIZE_QVGA`. Lower `jpeg_quality` number = better quality but bigger frames. |
| "Camera init failed" error | Check wiring, ensure correct board is selected in Arduino IDE (AI Thinker ESP32-CAM). |
