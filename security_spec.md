# WayHome Security Specification & Audit

## 1. Data Invariants
1. **Owner-Only Profile & PII Isolation**: `/users/{userId}` can only be read or written by `request.auth.uid == userId`. No blanket reads or list queries are permitted on `/users`.
2. **Share-Code Gate for Watcher Access**: `/shareCodes/{code}` prohibits `list` queries (`allow list: if false`). Only an authenticated, email-verified parent or faculty adviser who possesses the exact uppercase alphanumeric `shareCode` can `get` the lookup and create a deterministic `/watcherLinks/{studentId}_{watcherUid}` document verified against `get(/databases/$(database)/documents/shareCodes/$(incoming().shareCode))`.
3. **Instant Synchronous Revocation**: `/studentProfiles/{studentId}`, `/commutes/{commuteId}`, and `/commutes/{commuteId}/meta/feed` check `isActiveWatcher(studentId)` via deterministic `get()` on `/watcherLinks/{studentId}_{request.auth.uid}` (`status == 'active'`). Setting `status = 'revoked'` or deleting the link immediately revokes all read/ping access.
4. **Master Gate & Zero-Cost-Explosion List Queries**: Every `allow list` rule evaluates only `resource.data` against `request.auth.uid` (zero `get()` or `exists()` calls inside `allow list`). Subcollection `/commutes/{commuteId}/meta/feed` disables `list` (`allow list: if false`) and validates the parent `/commutes/{commuteId}` document on `get`, `create`, and `update`.
5. **Terminal State Locking**: Once a `/commutes/{commuteId}` reaches `'arrived_home'` or `'cancelled'`, no further updates are permitted (`existing().status in ['en_route', 'sos_alert']`).
6. **Temporal Integrity & Field Immutability**: All `createdAt` and `updatedAt` timestamps are strictly validated against `request.time`. Ownership and structural IDs (`id`, `ownerUid`, `studentId`, `studentOwnerUid`, `shareCode`, `createdAt`) are immutable after creation.

## 2. Adversarial "Dirty Dozen" Attack Payloads
1. **Cross-User Profile Scrape**: `list /users` as signed-in user -> **DENIED** (`allow list: if false`).
2. **Unverified Email Write**: `create /studentProfiles/stu_1` with `email_verified: false` -> **DENIED** (`isVerifiedEmail()` required).
3. **Identity Spoofing on Student Profile**: `create /studentProfiles/stu_2` with `ownerUid: "victim_uid"` -> **DENIED** (`incoming().ownerUid == request.auth.uid`).
4. **Shadow Field Injection**: `update /studentProfiles/stu_1` including extra field `isAdmin: true` -> **DENIED** (`keys().hasOnly(...)` + `affectedKeys().hasOnly(...)`).
5. **Share Code Enumeration**: `list /shareCodes` -> **DENIED** (`allow list: if false`).
6. **Forged Watcher Link**: `create /watcherLinks/stu_1_attacker` using fake `shareCode: "FAKE99"` -> **DENIED** (`exists(/shareCodes/FAKE99)` and matching `studentId` & `studentOwnerUid` required).
7. **Revoked Watcher Self-Restore**: Revoked watcher attempts `update /watcherLinks/stu_1_attacker` setting `status: "active"` -> **DENIED** (`existing().status == 'active'` required for watcher updates).
8. **Path Variable ID Poisoning**: `create /commutes/invalid$id` or 1.5KB ID string -> **DENIED** (`isValidId(commuteId)` checks length <= 128 and `^[a-zA-Z0-9_\-]+$`).
9. **Terminal Commute Tampering**: Student or watcher attempts to update `/commutes/c1` when `existing().status == 'arrived_home'` -> **DENIED** (`existing().status in ['en_route', 'sos_alert']`).
10. **Client-Forged Timestamp**: `create /commutes/c2` with backdated `createdAt` (`!= request.time`) -> **DENIED** (`incoming().createdAt == request.time`).
11. **Watcher Coordinate Hijack**: Parent/adviser attempts `update /commutes/c1` changing `currentLat` or `currentLng` -> **DENIED** (watcher action branch restricts `affectedKeys().hasOnly(['status', 'sosNote', 'updatedAt'])` only when resolving `sos_alert`).
12. **Unbounded Array / Resource Exhaustion**: `update /commutes/c1/meta/feed` with 150 breadcrumbs -> **DENIED** (`data.breadcrumbs.size() <= 100` and `data.events.size() <= 40`).

## 3. Red Team Audit Checklist
- Default-deny global catch-all present (`match /{document=**} { allow read, write: if false; }`): PASS
- Every `is string` check paired with `.size()` check: PASS
- Every `create` uses `keys().hasAll(...) && keys().hasOnly(...)`: PASS
- Every `update` starts with `isValid[Entity](incoming())` and uses action-based `affectedKeys().hasOnly(...)`: PASS
- Zero `get()`/`exists()` calls in any `allow list`: PASS
- Email verification (`request.auth.token.email_verified == true`) enforced on all operations: PASS
