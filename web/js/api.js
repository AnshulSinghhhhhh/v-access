const TOKEN_KEY = 'vaccess_token';
const ROLE_KEY = 'vaccess_role';

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}
export function getRole() {
  return sessionStorage.getItem(ROLE_KEY);
}
export function setToken(token, role) {
  sessionStorage.setItem(TOKEN_KEY, token);
  if (role) {
    sessionStorage.setItem(ROLE_KEY, role);
    if (role === 'admin') {
      document.documentElement.classList.add('is-admin');
    } else {
      document.documentElement.classList.remove('is-admin');
    }
  }
}
export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ROLE_KEY);
  document.documentElement.classList.remove('is-admin');
}

// Immediate synchronous check to prevent layout shifts
if (getRole() === 'admin') {
  document.documentElement.classList.add('is-admin');
}

export class ApiClientError extends Error {
  constructor(message, field, status) {
    super(message);
    this.field = field;
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiClientError('Could not reach the server. Check your connection and try again.');
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    // no body
  }

  if (!res.ok) {
    if (res.status === 401) {
      clearToken();
    }
    throw new ApiClientError(data.error || 'Something went wrong.', data.field, res.status);
  }
  return data;
}

// Fetches a protected binary resource (e.g. a social post image) with the
// bearer token attached, since a plain <img src="..."> cannot carry an
// Authorization header. Returns an object URL the caller should revoke
// with URL.revokeObjectURL() once the image is no longer needed.
export async function fetchAuthenticatedImageUrl(path) {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiClientError('Could not load image.', null, res.status);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Triggers a browser download of a protected file (e.g. a note) using the
// bearer token, since a plain <a href download> cannot carry an
// Authorization header either.
export async function downloadAuthenticatedFile(path, suggestedFileName) {
  const token = getToken();
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let message = 'Could not download this file.';
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {
      // response wasn't JSON (e.g. a raw file stream on success, or an empty error body)
    }
    throw new ApiClientError(message, null, res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedFileName || 'download';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Fetches the current user and reveals any element with id="nav-admin-link"
// when they're an admin. Purely a UX nicety — the real authorization
// boundary is server-side (requireRole on every admin API), never this.
export async function revealAdminNavIfApplicable() {
  const link = document.getElementById('nav-admin-link');
  if (getRole() === 'admin') {
    document.documentElement.classList.add('is-admin');
    if (link) link.hidden = false;
  }

  try {
    const result = await api('/api/auth/me');
    if (result.user?.role) {
      sessionStorage.setItem(ROLE_KEY, result.user.role);
      if (result.user.role === 'admin') {
        document.documentElement.classList.add('is-admin');
        if (link) link.hidden = false;
      } else {
        document.documentElement.classList.remove('is-admin');
        if (link) link.hidden = true;
      }
    }
    return result.user;
  } catch {
    return null;
  }
}

// Redirects to login if there is no session token. Call at the top of any
// authenticated page. Real authorization still happens server-side on every
// request — this only prevents flashing protected UI before redirecting.
export function guardAuthenticatedPage() {
  if (!getToken()) {
    window.location.href = '/index.html';
    return false;
  }
  return true;
}
