# PatchPilot Refactoring & Improvement Plan

## Phase 1: Architecture & Cleanup (High Priority)

- [ ] **Unify Git Logic**
  - [ ] Verify `src/gitSecure.ts` covers all functionality of `src/git.ts`.
  - [ ] Replace imports of `src/git` with `src/gitSecure` in `src/extension.ts`, `src/applyPatch.ts`, and tests.
  - [ ] Delete `src/git.ts`.
  - [ ] Rename `src/gitSecure.ts` to `src/git.ts` (and update imports back).

- [ ] **Decouple `applyPatch.ts`**
  - [ ] Create `src/patch/PatchSession.ts`: Move `pendingPatches`, `patchQueue`, and UI logic (diff editor management).
  - [ ] Create `src/patch/PatchParser.ts`: Move `parsePatch`, `extractFilePath`, and normalization logic.
  - [ ] Refactor `src/applyPatch.ts` to act as a coordinator using the new modules.

## Phase 2: Build System Consolidation

- [ ] **Migrate to esbuild completely**
  - [ ] Update `package.json` scripts: change `dev` script to use `esbuild` (watch mode) instead of webpack.
  - [ ] Remove `webpack.config.js`.
  - [ ] Remove webpack-related dependencies from `package.json`.

## Phase 3: Security & Reliability

- [ ] **Centralize Path Sanitization**
  - [ ] Create `src/security/pathSanitizer.ts`.
  - [ ] Move logic from `extractFilePath` (in `applyPatch.ts`) and `isValidFilePath` (in `gitValidation.ts`) to this new module.
  - [ ] Apply consistent sanitization across the app.

- [ ] **Fix Memory Leaks (Dangling Sessions)**
  - [ ] Implement `vscode.workspace.onDidCloseTextDocument` listener.
  - [ ] Clean up `pendingPatches` map when a user manually closes a diff tab without accepting/skipping.

## Phase 4: Future Improvements (Backlog)

- [ ] **Partial Hunk Application**: Allow users to select specific hunks to apply.
- [ ] **Webview UI Toolkit**: Refactor `webview/main.ts` to use VS Code Webview UI Toolkit.
