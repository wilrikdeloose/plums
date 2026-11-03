# PLuMS PoC

Read PLUMS_SPEC.md. These two files are the current PoC instructions.

- Use React, TypeScript, Vite and npm. Use Tauri 2/Rust for native desktop functions.
- Keep chat, context selection, AI orchestration, tool policy and planning in shared TypeScript. UI/core must not import Tauri, Node or native filesystem APIs.
- Use small asynchronous interfaces for DataStore, SecretStore, HttpTransport and McpClient. Inject web/desktop implementations at startup; keep native code out of the web build.
- Desktop stores data in your.data next to the executable; macOS next to the outer .app bundle. Browser uses IndexedDB. Both use the same data model.
- Desktop supports built-in Canvas MCP or a remote MCP URL. Browser supports remote MCP only. Both expose the same functions to the shared app.
- Keep the actual interface and assistant responses in Dutch.
- Canvas is strictly read-only. Enforce allowed tools and categories on every call, and allowed GET endpoints inside our Canvas server.
- Keep secrets out of ordinary settings, chat context, logs and exports. Handle credentials in the appropriate platform adapter.
- Use real connections when configured. Clearly label demonstration data and report missing capabilities or failed connections.
- Build only the requested step. Verify the relevant desktop/browser behaviour, and report the commands/results in chat.
- Keep the PoC small. Create only functional source/configuration files and these two instruction files. Do not create README files, gitignore files, Git operations, progress reports or additional architecture documents.

