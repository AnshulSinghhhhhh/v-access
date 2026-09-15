// Post-deployment smoke test. Run this against a freshly deployed instance
// to catch "it's up but misconfigured" failures before real users hit them.
//
// Usage: node scripts/smoke-test.js [base_url]
//   defaults to http://localhost:4000
//
// Written in plain Node (using the built-in fetch) rather than a shell
// script calling curl, so it runs identically on Windows, macOS, and
// Linux with nothing extra installed — matching the rest of this project's
// zero-dependency approach.
//
// Deliberately does NOT attempt a full register->verify->login round trip:
// in a real deployment (EMAIL_TRANSPORT=smtp), this script has no way to
// read the OTP out of a real inbox, so "waiting for an email" is not
// something a smoke test can or should simulate. What it checks instead is
// everything observable from the outside: the server is up, validation is
// enforced, security headers are present, and auth endpoints fail closed
// (not with a 500) on bad input.

const baseUrl = process.argv[2] || 'http://localhost:4000';
let failed = false;

function check(description, pass, detail) {
  if (pass) {
    console.log(`  OK   ${description}`);
  } else {
    console.log(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
    failed = true;
  }
}

async function main() {
  console.log(`Smoke testing ${baseUrl}\n`);

  console.log('1. Liveness');
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();
    check('GET /api/health responds with 200', res.status === 200, `got ${res.status}`);
    check('health body reports ok:true', body.ok === true);
  } catch (err) {
    check('server is reachable at all', false, err.message);
    return printResultAndExit(); // nothing else will succeed if this failed
  }

  console.log('\n2. Static frontend is served');
  const indexRes = await fetch(`${baseUrl}/index.html`);
  check('GET /index.html responds with 200', indexRes.status === 200, `got ${indexRes.status}`);

  console.log('\n3. Security headers are present (catches a misconfigured reverse proxy stripping them)');
  const headerRes = await fetch(`${baseUrl}/api/health`);
  check('X-Content-Type-Options present', headerRes.headers.get('x-content-type-options') === 'nosniff');
  check('X-Frame-Options present', headerRes.headers.get('x-frame-options') === 'DENY');
  check('Content-Security-Policy present', !!headerRes.headers.get('content-security-policy'));

  console.log('\n4. Auth validation fails closed, not with a 500');
  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password: 'x' }),
  });
  check('invalid login payload returns a client error, not 500', badLogin.status === 422, `got ${badLogin.status}`);

  const badDomainRegister = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: 'Smoke Test', email: 'smoketest@gmail.com', password: 'Passw0rd1' }),
  });
  check(
    'registration with a non-VIT email domain is rejected',
    badDomainRegister.status === 422,
    `got ${badDomainRegister.status}`
  );

  console.log('\n5. Protected routes require authentication');
  const protectedRes = await fetch(`${baseUrl}/api/dashboard/summary`);
  check('unauthenticated dashboard request is rejected', protectedRes.status === 401, `got ${protectedRes.status}`);

  printResultAndExit();
}

function printResultAndExit() {
  console.log();
  if (failed) {
    console.log('One or more smoke checks FAILED — investigate before directing real traffic here.');
    process.exit(1);
  } else {
    console.log('All smoke checks passed.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Smoke test crashed unexpectedly:', err);
  process.exit(1);
});
