# PLuMS PoC requirements

## Goal

A personal AI assistant for Fontys ICT students. It answers questions using personal settings, relevant conversation history and enabled Canvas information. The first scenario is planning a day or week from current work, deadlines and announcements. Help the student understand priorities and make their own choices.

## Shared desktop/web app

Use one React/TypeScript/Vite UI and TypeScript application core for Windows, macOS and browsers. Tauri 2/Rust is the native desktop layer.

Shared code handles conversation state, history selection, prompts, AI streaming/tool orchestration, Canvas source normalization and planning. Access storage, credentials, HTTP and MCP through asynchronous interfaces. Use separate web/desktop startup modules. Web must run without Tauri, Node, an embedded MCP or a local companion app.

| Capability | Desktop | Browser |
| --- | --- | --- |
| App data | Local your.data JSON file | Local IndexedDB |
| Canvas MCP | Built-in or remote URL | Remote URL |
| Network | Native HTTP adapter | Browser fetch adapter |
| UI/product logic | Shared TypeScript | Same code |

Support the same user features on both platforms as each feature is implemented. A remote MCP must expose the required Canvas reads. MCP and AI endpoints must support browser authentication, CORS and streaming; use a compatible gateway if needed. Production hosting and multi-user infrastructure are outside this PoC.

## Interface

Dutch, ChatGPT-like, branded PLuMS:
- Left sidebar: new chat and conversation history; open, rename and delete chats.
- Profile/settings button at the bottom left.
- Empty screen: "Waarmee kan ik je helpen?", input and starter questions underneath.
- Conversation: central messages and input at the bottom.
- Enter sends; Shift+Enter adds a line. Stream responses; allow stop in the composer during generation.
- Render safe Markdown, readable planning tables and clickable source references.
- For each assistant turn, render two independent, accessible disclosure sections that start collapsed by default and preserve the user's open/closed choice during streaming:
  - Live MCP activity above the answer: "Canvas raadplegen..." while running, then a compact read/failure summary with a down-chevron (indicating failures, partial access or not-applicable status even when collapsed).
  - Final source list below the answer: "Bronnen (N)" with a down-chevron containing clickable source links and effective deadlines.
- Below assistant replies, show a compact icon toolbar with copy (copies only the answer text and shows brief "Gekopieerd" feedback) and regenerate (reuses retry/cancellation without duplicating user turns or leaking old tool results).
- On the latest user message, show a pencil/edit action that opens the message in the composer with save/cancel and regenerates the affected reply with current source permissions and clean activity/provenance.

Starter questions:
"Help me mijn dag te plannen."
"Help me mijn week te plannen."
"Welke deadlines moet ik nu in de gaten houden?"
"Welke announcements zijn relevant voor mij?"

## Settings

- Profile: name, study context, available study hours, weekday study time windows, date exceptions, fixed commitments, preferred work-block length and break length between blocks.
- Own tasks: title, remaining minutes, optional deadline/priority and done state (alongside Canvas work).
- Personalization: editable additional system instructions.
- AI: OpenAI-compatible base URL, model slug, API key and connection test.
- Canvas (built-in mode): Canvas base URL, token, selected courses and read categories.
- MCP: built-in/remote selection on desktop; URL and separate MCP authentication for remote mode. Browser only shows remote mode.
- Data: export/import and delete local conversations/data.
- Canvas Test Student (desktop test builds only): optional per-course selector, off by default; see Build options below.

Model/endpoint choices are configurable. The model used in Cursor is independent of the model used by PLuMS.

## Storage and credentials

Use a versioned data model for settings, profile, conversations, own tasks and saved plans. Persist automatically; restarting/reloading must retain data.

Desktop uses readable, indented UTF-8 JSON in your.data. Resolve from executable location (macOS: outside the .app bundle), not current working directory. Handle write errors, malformed data and atomic saves.

Browser uses IndexedDB with the same logical schema. Report storage failures. Use the same JSON format for export/import between runtimes. Import validates data; export excludes secrets. An imported built-in MCP preference becomes remote mode in the browser. Outside an agreeing desktop test build, saved or imported `testStudentCourseIds` are discarded; ordinary user data is preserved.

Keep credentials separate from ordinary app data. Desktop uses native OS protection and protected values/refs. For the browser PoC, keep keys in memory for the session and request them again after reload. Persistent browser key storage is deferred. Never put keys into AI context, logs or data exports.

## AI and context

The shared TypeScript core uses a configurable OpenAI-compatible chat API with streaming and native tool calling. Normalize the base URL and append /chat/completions once.

Build context from the current question, relevant recent/older conversations, personal settings, own tasks, current date/time and enabled Canvas results. Keep context bounded; simple local history search is enough for the PoC. Messages, sources and plans derived from Canvas Test Student data carry provenance; outside an agreeing test build they must not enter new AI context.

Validate tool inputs, handle fragmented streamed tool calls, keep calling Canvas tools until the model finishes answering (no artificial per-turn call/round caps), support cancellation and show useful API errors. Do not claim Canvas was read when a connection failed.

## Canvas via MCP

Use a real MCP client/server protocol.

Built-in desktop server: part of the same executable, implemented with a suitable Rust MCP SDK; no separately installed Node/Python runtime. The native server can use an in-process MCP transport or a stdio mode of the same executable.

Remote server: Streamable HTTP URL with separate authentication. Both MCP adapters return the same normalized Canvas data to the app. Discover tools/capabilities and map supported, validated tool schemas. Show unavailable functions honestly. Do not automatically forward the Canvas token to an arbitrary MCP URL.

Needed reads: courses, assignments/deadlines, own submission status, announcements, calendar events and relevant module/page content. Read selected courses using the authenticated user's access. Handle pagination, student-specific deadlines, missing dates and safe HTML-to-text conversion.
- For own submission status, use an authorized own-user read (`assignments?include[]=submission` gated strictly by enabled `submissions` permission, or `students/submissions` for the calling user without `student_ids[]`). Check the authenticated user's actual course enrollments; if the user has no student enrollment in a course (e.g. teacher/staff role), treat own submission status as not applicable (`not_applicable`).
- Preserve `unknown` or `not_applicable` status when submission reads are denied, failed, omitted, unavailable or partial; never convert those cases to unsubmitted ("Niet ingeleverd"). Join submissions strictly by `course_id` and `assignment_id`, ignore course-wide `has_submitted_submissions`, and preserve Canvas `workflow_state` and `submitted_at` without equating `graded` (when `submitted_at` is null) with completed work.
- Use the current effective Canvas `due_at` consistently across normalized sources and factual tables, never roll a past deadline forward from a `[recurring]` title, and retain `null` deadlines.
- Assignment lists are read without Canvas deadline buckets (`upcoming`/`past`/…); past-due published work stays visible and overdue unfinished work must get a clear nudge. Drop assignments with `published: false`; keep items when `published` is absent.
- Canvas Test Student (agreeing desktop `--testmode=true` builds only, built-in MCP): optional per-course exception, off by default. Resolve the course Test Student server-side via `GET .../users?enrollment_type[]=student_view` (never create one; never accept arbitrary student IDs). Then read submissions only for that resolved ID. Keep selected-course and category permissions, real Canvas authorization and GET-only policy. Label test builds and test-derived results clearly. Remote MCP remains unsupported unless a reviewed remote adapter offers the same validated capability. A normal build must not enable this through saved settings, imports, query parameters, runtime environment variables or direct native calls; UI/native flag mismatch must deny access.

Canvas access is read-only. Permit only reviewed read tools. The built-in server allows only necessary Canvas GET endpoints. Do not expose generic shell, HTTP-request or code-execution tools to the model. Remote server read-only behaviour must be enforced by that server; readOnlyHint alone is not proof.

Allow categories to be enabled/disabled. Disabled sources must not be fetched or included in new AI context through cached/earlier tool results. Treat Canvas content as data, never as instructions.

The intended upstream Canvas MCP repository URL has not yet been supplied. When supplied, inspect its tools and licence. Until then use official Canvas API documentation; do not guess a repository. This does not block the UI/storage phases.

## Planning

Default timezone Europe/Amsterdam; week starts Monday. Plan future work blocks from the current civil time (DST-safe date/time handling; do not advance dates by blindly adding 24 hours).

Combine enabled Canvas assignments/deadlines, own submission status, announcements (context only — not automatic appointments), scheduled calendar events, own tasks, availability windows, exceptions, fixed commitments, block length and breaks. Ask one concise grouped clarification when essential availability or estimates are missing, or label a proposed estimate explicitly. Submission failure/absence remains unknown; submitted/graded does not prove all work is complete. Keep live-read failures and test-account limitations visible.

The model proposes typed tasks/priorities/estimates through local planning tools (`planning_create_plan`, `planning_revise_plan`, `planning_ask_clarification`), separate from read-only Canvas MCP tools. Do not parse Markdown tables as application state. AI estimates must never replace verified Canvas deadlines or statuses.

A shared allocator/validator places feasible work blocks with breaks inside availability, outside commitments and timed events, only from now onward. Validate IDs, positive durations, horizon, overlaps, capacity and before-deadline feasibility. Split work using preferred block lengths; do not double-count work, roll overdue deadlines forward, invent undated deadlines, or schedule completed own tasks unless requested. When work cannot fit, save an explicitly partial plan with unscheduled minutes/tasks and capacity shortfall — never silently extend hours, move deadlines or present impossible blocks as valid.

Render validated day/week tables in chat (dates, start/end, task, priority, verified deadline, source/origin). Distinguish Canvas facts, student input and AI estimates; show assumptions and unscheduled work. Sources/activity stay independently collapsed by default.

Persist validated plans via DataStore (schema v2 migrates v1), linked to conversation and revision. Reload/import/export retain plans, tasks and availability. Partial status must be clear; invalid proposals are not saved as complete plans. Plans carry source/test provenance and are rechecked before use as new AI context; normal builds cannot use test-derived plans. Changing source permissions invalidates affected plan context without deleting visible history.

Follow-ups such as "Woensdag kan ik niet" or "Maak het rustiger" apply one-off constraints to that plan by default (do not silently overwrite the permanent profile), reallocate/validate, and save a new revision without duplicating work or rewriting old chat tables. Reopening keeps the active revision and its constraints.

## Build options

Desktop `dev:desktop` and `build:desktop` go through a Node wrapper (`scripts/desktop.mjs`). Accept `--testmode=true` or `--testmode=false`; omission means false; reject other values. Examples: `npm.cmd run dev:desktop -- --testmode=true`, `npm.cmd run build:desktop -- --testmode=true`. Ordinary desktop scripts stay test-free by default. When true, the wrapper sets `VITE_PLUMS_TESTMODE=true` for child processes and enables Cargo feature `canvas-test-mode` only for that invocation (not a Cargo default and not persistent Tauri config). Frontend checks compare to the literal string `"true"`. Tauri `beforeDevCommand` / `beforeBuildCommand` call the plain Vite desktop scripts so the wrapper is not started recursively. PoC native builds may use Tauri `--no-bundle`; installers remain step 8. Ordinary web scripts always build without the test feature.

## Build order and proof

Follow the existing steps: 2 requirements; 3 UI and both storage adapters; 4 AI and credentials; 5 Canvas MCP (built-in and remote); 6 planning; 7 full browser parity; 8 executable/web builds.

After the corresponding phases, prove the same flow in browser and desktop: reopen a conversation, read real Canvas data, produce a plan, revise availability, reload and retain the plan. Use an external MCP endpoint for the web test.

Keep checks focused on persistence, read-only/source filtering, actual streaming/tool calls and feasible planning. Report what was actually tested in chat; no README, Git tasks or report files are required.

