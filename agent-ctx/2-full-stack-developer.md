# Task 2 — full-stack-developer (backend: player panels API)

Date: 2026-09-20 · Status: ✅ complete · Worklog entry appended (Task ID: 2)

## What was built

| Deliverable | Path | Status |
|---|---|---|
| Prisma model | `prisma/schema.prisma` → `PlayerComment` (+ `bun run db:push`) | ✅ |
| Interactions API | `src/app/api/player/interactions/route.ts` (GET + POST) | ✅ |
| Extras API | `src/app/api/player/extras/route.ts` (GET) | ✅ |

## Contracts as implemented

### GET /api/player/interactions?threadKey=&type=comment|doubt
- threadKey required (1..200), type defaults `comment`; invalid → 400 `{success:false, error:'threadKey and type are required'}`.
- Two queries: top-levels `{threadKey, type, parentId: null}` orderBy createdAt asc → replies `findMany({ where: { parentId: { in: topIds } } })` grouped in JS.
- 200: `{ success: true, items: [{ id, author, text, createdAt: ISO, parentId: null, replies: [{ id, author, text, createdAt: ISO, parentId }] }] }`

### POST /api/player/interactions
- Body `{ threadKey, type, text, author?, parentId? }`; author trimmed ≤40 default "Student"; text trimmed 1..2000.
- parentId must exist (else 404) and be top-level (else 400 — one-level threading only).
- 200: `{ success: true, item: { id, author, text, createdAt: ISO, parentId } }`
- Invalid JSON → 400; db failure → 500 friendly message. All errors: `{ success: false, error }`.

### GET /api/player/extras?batchId&scheduleId&subjectId&videoId
- contentId = scheduleId || videoId → `lxScheduleDetail(batchId, subjectId, contentId)` (reused, no new upstream plumbing) with 12s Promise.race timeout guard.
- notes = homeworkIds[] (+ upstream `dpp.homeworkIds[]`, merged to match the pw_sch_dtl transform / LectureData) → `{name: topic || decoded filename, url: baseUrl+key}`.
- attachments = exerciseIds[] (title/topic/name || filename) → `{name, url}`.
- slides = videoDocUrl / docUrl / slidesUrl / docUrlObj / attachmentIds found on the item or its videoDetails → `{name, url}`, else [].
- Per-array dedupe by url. NEVER throws: missing ids / timeout / not-found / bad shape → 200 `{success:true, slides:[], notes:[], attachments:[], warning:"…"}`.

## Verification (curl, dev server untouched)
- `GET …interactions?threadKey=test-thread&type=comment` → `{"success":true,"items":[]}`
- POST comment → item `cmua0n7cz0000pptuq29lyp4b`; POST reply (parentId) → nested in GET `replies[]`
- Reply-to-reply → 400; bad parentId → 404; empty threadKey / bad type → 400; blank text → 400; doubt thread isolated
- `GET …extras?batchId=x&scheduleId=y` → 200 + warning; no ids → warning; REAL ids → `notes:[{name:"JD LEE JEE Advanced Content (One Shot)  Class Notes.pdf", url:"https://static.pw.live/…pdf"}]`
- dev.log lines ~700-746: clean compiles, no errors.

## Notes for next agents
- Frontend (main agent) owns UI wiring; safe per-lecture switch: threadKey convention is frontend's choice (e.g. `${batchId}:${scheduleId}:${type}`).
- No auth/session on either route — open API by design for this clone.
- Did NOT touch src/app/player/*, src/components/*, src/lib/api-client.ts; did NOT restart dev server; no build/lint/test files.
