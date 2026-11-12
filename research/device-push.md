# How should Cadence push Notifications to devices?

Research for [#10](https://github.com/elassiter/cohort-005-project-fork-two/issues/10), part of the wayfinder map [#9](https://github.com/elassiter/cohort-005-project-fork-two/issues/9). Sources checked on 2026-11-12.

## Context

- Cadence is a React Router web app with no native mobile app. Production runs `react-router-serve` (see `package.json`).
- It runs as **one Node process on one SQLite file** through better-sqlite3 and Drizzle ([ADR 0006](../docs/adr/0006-one-sqlite-file-through-drizzle.md)).
- Every Notification is stored in the in-app inbox first. Device push is an extra delivery channel on top of the inbox. Email is out of scope.
- A recipient can have any role: Student, Instructor, Team Admin or Platform Admin.

This note answers two questions:

1. **Device push:** how a Notification reaches a phone or desktop when no Cadence tab is open.
2. **Open tab:** how a Cadence tab that is already open shows a new Notification straight away.

## 1. Device push: the standard Web Push API

### How it works

- The page registers a **service worker** and calls `PushManager.subscribe()`. This returns a `PushSubscription`, which holds "an endpoint and the encryption key needed for sending data" ([MDN: Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)).
- The browser starts the service worker when a message arrives and fires the `push` event. The worker then calls `showNotification()` (MDN, same page).
- To send, the server makes an HTTP `POST` to the subscription's endpoint, which belongs to the browser vendor's push service ([RFC 8030 §5](https://www.rfc-editor.org/rfc/rfc8030#section-5)).
  - Every request **must** include a `TTL` header, or the push service returns `400` ([RFC 8030 §5.2](https://www.rfc-editor.org/rfc/rfc8030#section-5.2)).
  - The `201` response only means the push service accepted the message. It does not confirm delivery (RFC 8030 §5).
- The server identifies itself with a **VAPID** key pair. This is a signed JWT plus the server's public key ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)).
- The message body is encrypted for that subscription. A push service only has to accept 4096 bytes, which leaves **at most 3993 bytes of plaintext** ([RFC 8291 §4](https://www.rfc-editor.org/rfc/rfc8291#section-4)).
  - In practice, send a small `{ id, title, body, url }` and let the inbox hold the full Notification.
- No account with any vendor is needed. The push services that browser vendors run are free to call.
  - Apple's documentation says: "You do not need to be a member of the Apple Developer Program to use it" ([WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).

### Browser and platform support

| Platform | Support | Source |
| --- | --- | --- |
| Desktop Chrome, Edge, Firefox; Android Chrome and Firefox | Supported. No install needed. | [MDN: Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) (Baseline "widely available", "available across browsers since March 2023") |
| macOS Safari 16.1+ (Ventura+) | Supported in a normal Safari tab | [WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) |
| iOS / iPadOS 16.4+ | **Only after the person adds Cadence to the Home Screen** as a web app | [WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) |

To get push on iPhone and iPad, Cadence needs three things (all from the WebKit blog above):

- a web app manifest with `display: "standalone"` (or `"fullscreen"`)
- a Home Screen install by the person
- a permission request made from a direct user action, such as tapping a button. A request on page load does not qualify.

Apple delivers these messages through APNs. If the server restricts which hosts it calls, it must allow `*.push.apple.com` (WebKit blog).

Firefox caps how many push messages a site can send that do **not** show a notification. Messages that show a notification are exempt ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)). So the worker should **always** call `showNotification` for every push.

### What the server stores per device

Store one row per subscription. A person can have several subscriptions, one per browser or install:

- `endpoint` (unique)
- `p256dh` and `auth` keys
- `userId`
- `createdAt` and `lastSeenAt`

Handling rules:

- **Keep the endpoint secret.** It is a capability URL: anyone who knows it can send pushes to that device ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)).
- **Protect the subscribe endpoint against CSRF** (same MDN page).
- **Delete the row when a send returns `404` or `410`.** A push service must return `404` for an expired subscription ([RFC 8030 §7.3](https://www.rfc-editor.org/rfc/rfc8030#section-7.3)). Treat `410 Gone` the same way: RFC 8030 uses it for messages and subscriptions that no longer exist.
- **Handle `pushsubscriptionchange`** in the service worker so the browser can replace an old subscription with a new one (MDN).

## 2. Device push: hosted providers

### Firebase Cloud Messaging (FCM)

- **Price:** "Cloud Messaging (FCM): No-cost" on both the Spark and Blaze plans ([Firebase pricing](https://firebase.google.com/pricing)).
- **Same browser limits:** On the web, FCM uses the same W3C Push API. It only works "in browsers that support the Push API" and still needs **VAPID keys** and a service worker ([FCM web get-started](https://firebase.google.com/docs/cloud-messaging/web/get-started)). So it does not remove the iOS Home Screen requirement.
- **Same storage work:** FCM tells you to store each device's installation ID or token on your own server, with a timestamp, and to remove stale ones yourself ([FCM: manage tokens](https://firebase.google.com/docs/cloud-messaging/manage-tokens)). Cadence would still need its own device table.
- **What it adds:**
  - the Firebase JS SDK in the client bundle
  - a Google Cloud project
  - a service-account credential on the server
  - a second identity (the FID) that has to be linked to the Cadence user

### OneSignal

- **Free plan:** web push is capped at "Max 10,000 subscribers per send" ([OneSignal pricing](https://onesignal.com/pricing)).
- **Growth plan:** "$0.004 per web push subscriber", on a plan that "Starts at $19/mo" (same page).
- **What it adds:**
  - a dashboard, segments, journeys, analytics and A/B testing. These are marketing features Cadence does not need for transactional Notifications.
  - its own SDK and service worker
  - each subscriber stored on OneSignal's side, which Cadence then has to keep linked to its own user (an external-ID mapping)
- **Same browser limits:** underneath, OneSignal sends through the same browser push services. It cannot get around the iOS Home Screen requirement, because that rule comes from the platform ([WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).

### Summary

| | Web Push (self-run VAPID) | FCM | OneSignal |
| --- | --- | --- | --- |
| Cost | Free | Free | Free up to 10k subscribers per send, then paid |
| iOS | 16.4+, Home Screen only | Same | Same |
| Vendor account or SDK | None (one server library, e.g. `web-push`) | Google project + Firebase SDK | OneSignal account + SDK |
| Per-device storage in Cadence | Subscription row | FID/token row | External-ID mapping (data also held by OneSignal) |
| Personal data sent to a third party | Only the encrypted payload, to the browser vendor | Also Google | Also OneSignal |

A hosted provider only pays off if Cadence later ships native apps or wants marketing campaigns. Neither applies to this question.

## 3. Updating a tab that is already open

There are three ways for an open tab to learn about a new Notification.

### Server-sent events (SSE)

- **How it works:** The browser opens an `EventSource` to a URL. The server answers with `Content-Type: text/event-stream` and keeps the response open ([MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)).
- **It is one-way**, from server to browser. Cadence only needs that direction, because the tab already uses normal requests to mark a Notification as read.
- **Reconnects on its own.** The browser reconnects automatically and sends back `Last-Event-ID`, so the server can resend anything the tab missed ([HTML spec: server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)). If event IDs are inbox row IDs, a reconnecting tab gets every Notification it missed.
- **Fits the current server.** A React Router resource route can return a streaming `Response`, so `react-router-serve` needs no change.
- **Fits one process.** Because Cadence is a single process, an in-memory `Map<userId, Set<stream>>` is enough to fan a new inbox row out to that person's open tabs. No Redis or other pub/sub is needed. This assumption breaks only if Cadence ever runs more than one process, which ADR 0006 already rules out for now.
- **Watch out:** over HTTP/1.1, browsers allow only **6 connections per domain**, shared across all tabs. More Cadence tabs than that would stall other requests. HTTP/2 raises the limit to about 100 streams (MDN, same page). So serve Cadence over HTTP/2 (most TLS proxies do this already), or share one stream across tabs with a `BroadcastChannel`.

### WebSockets

- **Two-way.** Cadence does not need the browser-to-server direction for this.
- **Needs a custom server.** The connection starts with an HTTP upgrade, which `react-router-serve` does not handle. Cadence would have to replace it with a custom Express server plus a WebSocket library.
- **No built-in resume.** Unlike SSE, there is no `Last-Event-ID`, so Cadence would have to write its own logic to catch up on missed messages.

### Polling

- **How it works:** The tab calls a loader on a timer, for example with `useRevalidator`.
- **Simplest option**, and it works everywhere.
- **Trade-off:** each SQLite read is cheap, but Notifications arrive late by up to one interval, and every open tab makes a request on every tick even when nothing has changed.
- **Good fallback:** use it if the SSE stream keeps failing.

### Avoiding a duplicate alert in the open tab

If the tab is open and in focus, the service worker can check `clients.matchAll()` and skip the OS notification, because the tab already shows the new item. It still has to call `showNotification` in some cases to stay within the Firefox and Safari limits. A common pattern is to always show the notification but give it a `tag`, so repeats of the same alert are collapsed.

## Recommendation

**Use the standard Web Push API with self-run VAPID keys for device push, and server-sent events for open tabs. Do not use a hosted provider.**

Delivery flow:

1. The Cadence server writes the Notification to the inbox table.
2. In the same request, it hands the new row to:
   1. the in-memory SSE hub, which sends it to each of the recipient's open tabs, using the inbox row ID as the event ID
   2. a web-push sender, which `POST`s a small encrypted payload to each of the recipient's stored subscriptions, then deletes any subscription that returns `404` or `410`.

What Cadence must add:

- a `push_subscriptions` table: `id`, `userId`, `endpoint` (unique), `p256dh`, `auth`, `createdAt`, `lastSeenAt`
- a VAPID key pair, stored in environment variables
- a web app manifest with `display: "standalone"`
- a service worker that handles `push`, `notificationclick` (opens the Notification's URL) and `pushsubscriptionchange`
- an "Enable notifications" button, because the permission request must come from a user action
- an SSE resource route

### Trade-offs

- **iPhone and iPad users only get device push after they add Cadence to their Home Screen** and turn notifications on. Any provider has the same limit. Every user still sees the Notification in the inbox and in any open tab through SSE.
- **Cadence owns subscription cleanup, retries and the `TTL` choice.** The vendors cannot take this off its hands: FCM still makes Cadence store and clean up tokens itself.
- **Delivery is best-effort.** A `201` only means the push service accepted the message. That is acceptable, because the inbox is the record of truth.
- **The in-memory SSE hub assumes one process.** If Cadence moves to more than one process (which would also mean leaving ADR 0006), the hub needs a shared pub/sub, or the tabs fall back to polling.
- **Self-running keeps personal data with Cadence.** Payloads are encrypted from end to end, and there are no marketing tools, analytics dashboards or cross-channel journeys. A provider would only be worth revisiting if Cadence ships native apps.
