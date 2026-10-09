# Signup verification

Account creation requires a visible Cap widget by default. The native signup form shows an account verification section before Create Account. Submitting without a solved challenge keeps the form in place and focuses verification. Expired or consumed tokens require another solve, and failures offer Retry verification. Repeated form submissions share the pending registration request. The original body and complete success response are preserved. Ordinary field errors remain unchanged; uncertain results use recovery guidance. The next attempt can start when that request settles.

The API enforces this independently of the browser: missing, invalid, expired or reused `captcha_key` values return HTTP 400. Registration invitations do not bypass verification and are not consumed by requests missing verification. Set `register.requireCaptcha` in Site settings to change the instance policy.

The built-in integration uses [Cap core](https://trycap.dev/guide/capjs-core) and serves the widget, WASM solver and decompression fallback locally. No extra API key or separate service is required. Challenge signatures derive a dedicated key from the instance's persisted request signature secret. Browser instrumentation and 50 SHA-256 challenges at difficulty four run for each solve. Challenges and solved tokens expire after five minutes. Automated-browser blocking is off; browser instrumentation still runs.

Challenge nonce redemption and solved-token consumption use atomic PostgreSQL operations in the existing expiring `rate_limits` store. Concurrent replays admit one winner. Only token hashes are stored; cleanup uses the existing expiry worker. Public challenge and redemption routes each permit 30 requests per IP per minute independently of the generic rate-limit switch.

In Site settings, choose **Cap core (default)** or **Cap Standalone server**. Cap is the only captcha the server supports, and it dropped hCaptcha and reCAPTCHA. Core runs inside the instance and ignores any previously stored standalone URL or credentials. Standalone reveals its server URL, site key and masked secret fields; saving requires all three, with a valid HTTP or HTTPS URL. A blank secret preserves the existing secret.

Selecting Standalone also applies to required signup verification when the optional sign-in/reset captcha switch is off. An incomplete standalone configuration fails closed instead of falling back to core. The optional sign-in and password reset checks use the same Cap mode as signup.

The `/verify-email` page shows the Cap widget when email verification asks for a captcha.

## Native form

Repeated submissions of the native form share one pending registration request, so two quick submits send one HTTP request. Registration requests disable automatic retries. An interrupted request keeps the form, clears the uncertain one-use proof and offers sign-in with the original username and password. A successful response without a nonempty token also enters this recovery. Ordinary field errors keep their existing behavior. An HTTP 429 response shows the remaining wait and an explicit retry action without discarding form fields or replaying registration automatically.

The verification SDK must register its widget when the script finishes loading. An empty or incompatible HTTP 200 response shows Retry verification, and a stalled script request times out after 15 seconds. Failed attempts remove their script and release the shared loader, so retry fetches the SDK again.

Cap is a form-associated custom element, and its native constraint validation can reject `requestSubmit()` before the form submit handler runs. Validation errors focus the Cap trigger and expose the status and error through a description in its shadow tree. Routine updates use an atomic status region and urgent errors use an atomic alert. Retry verification has a 40-pixel minimum desktop height and 44 pixels for coarse pointers. [W3C description guidance](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA1) explains the description relationship.

Closed registration reports `DISABLED` for `register.disabled` and `REGISTRATION_DISABLED` for `register.allowNewRegistration: false` on the visible username field, because native signup has no email field by default. The valid proof stays available after either policy rejection, and an unsolved challenge still blocks signup.

## Email

Signup asks for a username and a password. The form has no email field, and `assets/client_patches/55-simple-signup.js` removes Discord's. Site settings has 3 switches under Registration that change this:

| Switch                   | Setting                     | Effect                                                                                                                                                                                                               |
| ------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Require an email address | `register.email.required`   | The form shows a required email field first, and the API rejects a registration without an email.                                                                                                                    |
| Verify email addresses   | `defaults.user.verified`    | On stores `false`: a new account starts unverified and gets a verification link. Off stores `true`: a new account counts as verified, with no link.                                                                  |
| Require a verified email | `login.requireVerification` | An unverified account can sign in and read, the server refuses what it tries to change, and the client holds it at a Verification Required screen. Accounts created while verification was off are already verified. |

`src/bundle/TestClient.ts` puts `register.email.required` in `GLOBAL_ENV.REGISTER_EMAIL_REQUIRED`, so the form follows the switch on the next page load, without a restart. Verification links need an email provider, see `SMTP_HOST` in [deploy.md](../self-hosting/deploy.md#environment).

Saving refuses to require a verified email while an email address is not required at signup, with HTTP 400 and nothing saved. That includes turning the email requirement off while the verified email requirement stays on.

Sign-in is never refused for an unverified account. The gateway sends `required_action: REQUIRE_VERIFIED_EMAIL` in `READY`, and the client replaces the app with a Verification Required screen. Its Verify by Email button opens a dialog with Resend Email and Change Email, so an account with a mistyped or missing address can fix it. The server sends `USER_REQUIRED_ACTION_UPDATE` to the account's open clients when its verification state changes: when the emailed link is opened, when an operator marks the account verified or unverified, and when the account changes its address. A client that is open on the screen leaves it without a reload.

The server enforces the requirement as well. While it is on, `route()` in `src/api/middlewares/Route.ts` answers every `POST`, `PUT`, `PATCH` and `DELETE` from an unverified account with HTTP 403 and code 40002, on each route that requires authentication. `GET` requests stay available. 3 routes set `allowUnverified` and stay open: `POST /auth/verify/resend`, `POST /auth/logout` and `PATCH /users/@me`, which the dialog uses to change the address. `POST /auth/verify` does not require a token. The gateway ignores a voice channel join from an unverified account. Bots are not held back. The encryption engine cannot register its keys while the account is held back, so it retries and finishes once the account is verified.

## Testing

Run mutation checks only against an isolated database. API-based test provisioning uses `scripts/dev/cap-token.mjs` to solve a real challenge in a browser; there is no production test bypass.

```sh
CAP_REGISTRATION_TEST=1 APPLY_DB_MIGRATIONS=false bun --env-file=<isolated .env> test ./scripts/tests/cap-registration.postgres.cjs
PORT=<port> bun scripts/dev/cap-signup-smoke.mjs
PORT=<port> bun scripts/dev/cap-disconnect-smoke.mjs
PORT=<port> bun scripts/dev/cap-disabled-smoke.mjs
```

The PostgreSQL suite covers challenge settings, nonce and token replay, expiry, malformed proofs, required signup and invitation bypass prevention. `cap-signup-smoke.mjs` checks missing verification, successful signup, reset, replay rejection, load failure and retry and the absence of external requests. `cap-disconnect-smoke.mjs` drops real HTTP responses through a local proxy to check interrupted-signup recovery without printing passwords or tokens. `cap-disabled-smoke.mjs` runs against an instance with registration disabled; set `REGISTRATION_DISABLED_CODE=REGISTRATION_DISABLED` to test the allow-new-registration switch. Each smoke accepts `BROWSER=webkit` for iPhone-sized WebKit, and `VENCORD_OUTPUT` selects a staged bundle.
