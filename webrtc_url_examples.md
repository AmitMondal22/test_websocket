# WebRTC URL & Connection URI Examples

WebRTC itself does not have a single native URL scheme (like `http://` or `rtsp://`) because it is a peer-to-peer protocol negotiated dynamically via SDP and ICE. However, several standardized URL patterns and connection endpoints are used across WebRTC architectures. 

Here are the most common examples of WebRTC-related URLs categorized by their role in the connection.

---

## 1. WebSocket Signaling URLs (For Custom Signaling Servers)
Before peers can connect, they connect to a signaling server to exchange SDP and ICE candidates. This typically uses standard WebSocket (`ws://` or `wss://`) protocols.

### Local Development (Non-secure)
```http
ws://localhost:3000/ws
```

### Production / Public (Secure WebSocket)
```http
wss://stream.yourdomain.com/ws
```
* **Note**: In modern browsers, if your web page is hosted on `https://`, you **must** use `wss://` (secure WebSockets) due to mixed-content security policies.

---

## 2. WHIP URLs (WebRTC HTTP Ingestion Protocol)
**WHIP** (RFC 9435) is the modern standard for pushing media stream inputs to a WebRTC server (e.g., from software like OBS Studio, GStreamer, or hardware encoders).

### WHIP Connection URL Format
```http
https://media-server.example.com/whip/endpoint/stream_12345
```

### OBS Studio WHIP Setup Example
* **Server URL**: `https://media.example.com/whip`
* **Bearer Token (Stream Key)**: `my-secret-auth-token-123`

---

## 3. WHEP URLs (WebRTC HTTP Egress Protocol)
**WHEP** (RFC draft) is the modern standard for pulling/subscribing to live streams for low-latency playback in custom media players or web interfaces.

### WHEP Connection URL Format
```http
https://media-server.example.com/whep/endpoint/stream_12345
```

---

## 4. STUN and TURN Server URLs (ICE Server URIs)
These are connection endpoints used by the browser's WebRTC engine (`RTCPeerConnection`) to fetch network coordinates (NAT traversal).

### STUN URLs (Session Traversal Utilities for NAT)
Used to discover the peer's public IP/port. No authentication is typically required.
```http
stun:stun.l.google.com:19302
stun:stun.services.mozilla.com
```

### TURN URLs (Traversal Using Relays around NAT)
Used as fallback servers to relay actual media streams when direct P2P connection paths are blocked. Authentication is required.
```http
turn:turn-server.example.com:3478
turns:turn-server.example.com:5349?transport=tcp
```
* **Format inside JavaScript**:
  ```javascript
  const iceConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { 
        urls: 'turn:turn-server.example.com:3478', 
        username: 'your-username', 
        credential: 'your-password' 
      }
    ]
  };
  ```

---

## 5. WebRTC Peer Connection Candidate URLs (ICE Candidate URIs)
During candidate exchange, WebRTC generates specific IP and port strings in candidate packets. These are the internal connection URIs the browser uses:

### Typical Host Candidate (Local Network Link)
```
candidate:842165921 1 udp 2122260223 192.168.1.15 54321 typ host
```
* **`192.168.1.15`**: The device's private IP.
* **`54321`**: The local UDP port.
* **`typ host`**: Represents a direct LAN connection option.

### Typical Server Reflexive Candidate (Public Router Link)
```
candidate:842165921 1 udp 1686052607 203.0.113.45 61002 typ srflx raddr 192.168.1.15 rport 54321
```
* **`203.0.113.45`**: The public external IP of the router (discovered via STUN).
* **`61002`**: The open external port mapped on the router NAT.
* **`typ srflx`**: Server Reflexive candidate (NAT public endpoint).
