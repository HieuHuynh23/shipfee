'use strict';

/**
 * Realtime hỗ trợ Shipper ↔ CRM qua Server-Sent Events (SSE).
 *
 * - 1 EventEmitter làm bus nội bộ (in-process). Các endpoint mutation gọi
 *   emitSupportEvent(...) để phát sự kiện; các kết nối SSE đang mở sẽ nhận ngay.
 * - openSseStream() thiết lập 1 kết nối SSE với heartbeat + cleanup an toàn.
 *
 * Lưu ý: bus chạy trong 1 process. Nếu sau này scale nhiều instance trên Render,
 * cần thay bằng pub/sub (Redis...) — hiện dịch vụ chạy 1 instance nên đủ dùng.
 */

const { EventEmitter } = require('events');

const supportBus = new EventEmitter();
supportBus.setMaxListeners(0);

/**
 * Phát 1 sự kiện hỗ trợ tới mọi client SSE đang lắng nghe.
 * @param {{type:string, shipperPhone?:string, threadId?:string, status?:string}} evt
 */
function emitSupportEvent(evt) {
  try {
    supportBus.emit('event', { ...evt, ts: Date.now() });
  } catch (_) {
    /* no-op */
  }
}

/**
 * Mở 1 kết nối SSE trên response `res`.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {(evt:object)=>boolean} filterFn Trả về true nếu event nên gửi cho client này.
 * @returns {Function} cleanup
 */
function openSseStream(req, res, filterFn) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Chặn proxy (nginx/Render) buffer response stream
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  try { req.socket.setNoDelay(true); } catch (_) { /* no-op */ }

  // Gợi ý client tự reconnect sau 3s nếu rớt
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');

  const listener = (evt) => {
    try {
      if (typeof filterFn === 'function' && !filterFn(evt)) return;
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch (_) {
      /* client đã ngắt — cleanup sẽ xử lý */
    }
  };
  supportBus.on('event', listener);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* no-op */ }
  }, 25000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    supportBus.off('event', listener);
    try { res.end(); } catch (_) { /* no-op */ }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
  return cleanup;
}

module.exports = { supportBus, emitSupportEvent, openSseStream };
