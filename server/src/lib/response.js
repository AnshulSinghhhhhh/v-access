export class ApiError extends Error {
  constructor(status, message, field) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.field = field;
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function ok(res, data = {}) {
  sendJson(res, 200, { ok: true, ...data });
}

export function created(res, data = {}) {
  sendJson(res, 201, { ok: true, ...data });
}
