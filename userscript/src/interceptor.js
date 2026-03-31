/**
 * interceptor.js
 *
 * Monkey-patches window.WebSocket at document-start so we can tap into
 * the VPL jail server's evaluation output stream.
 *
 * Must be injected BEFORE any page scripts run (@run-at document-start).
 */

(function () {
  "use strict";

  const OrigWS = window.WebSocket;
  const capturedFrames = []; // { url, data, timestamp }
  const capturedStreams = {}; // url -> [frames]

  function isJailServer(url) {
    // VPL jail WebSocket URLs typically look like:
    //   ws://jail.example.com:8080/  or  wss://vpl-jail.uni.edu/
    // We capture ALL non-Moodle WebSocket connections as potential jail traffic.
    // The extractor will filter further.
    try {
      const u = new URL(url);
      const moodleHost = window.location.hostname;
      return u.hostname !== moodleHost;
    } catch {
      return false;
    }
  }

  function recordFrame(url, data) {
    capturedFrames.push({ url, data, ts: Date.now() });
    if (!capturedStreams[url]) {
      capturedStreams[url] = [];
    }
    capturedStreams[url].push(data);
  }

  // Wrap the WebSocket constructor
  function VPLocalWebSocket(url, protocols) {
    let ws;
    if (protocols !== undefined) {
      ws = new OrigWS(url, protocols);
    } else {
      ws = new OrigWS(url);
    }

    if (isJailServer(url)) {
      // Tap into messages
      ws.addEventListener("message", function (event) {
        recordFrame(url, event.data);
      });

      ws.addEventListener("close", function () {
        // Signal to the extractor that a stream is complete
        window.dispatchEvent(
          new CustomEvent("vplocal:stream-complete", {
            detail: { url, frames: capturedStreams[url] || [] },
          })
        );
      });
    }

    return ws;
  }

  // Copy static properties and prototype
  VPLocalWebSocket.prototype = OrigWS.prototype;
  VPLocalWebSocket.CONNECTING = OrigWS.CONNECTING;
  VPLocalWebSocket.OPEN = OrigWS.OPEN;
  VPLocalWebSocket.CLOSING = OrigWS.CLOSING;
  VPLocalWebSocket.CLOSED = OrigWS.CLOSED;
  Object.defineProperty(VPLocalWebSocket, "name", { value: "WebSocket" });

  window.WebSocket = VPLocalWebSocket;

  // Expose captured data for the extractor
  window.__vplocalCapture = {
    getFrames: () => capturedFrames.slice(),
    getStreams: () => Object.assign({}, capturedStreams),
    clear: () => {
      capturedFrames.length = 0;
      Object.keys(capturedStreams).forEach((k) => delete capturedStreams[k]);
    },
  };
})();
