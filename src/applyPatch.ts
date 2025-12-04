/* --------------------------------------------------------------------------
 *  PatchPilot — AI‑grade unified‑diff applier
 * ----------------------------------------------------------------------- */

import * as vscode from 'vscode';
import * as DiffLib from 'diff';
import { normalizeDiff } from './utilities';
import { autoStageFiles } from './gitSecure';
import { getOutputChannel } from './logger';
import { trackEvent } from './telemetry';
import {
  PatchStrategyFactory,
  PatchResult,
} from './strategies/patchStrategy';
import {
  ApplyOptions,
  ApplyResult,
  FileInfo,
  DiffParsedPatch,
} from './types/patchTypes';
import { useOptimizedStrategies } from './strategies/optimizedPatchStrategy';

/**
 * Global state for pending patches waiting to be accepted via the diff editor.
 * Key: URI string of the modification view (right side).
 * Value: Data needed to apply the patch.
 */
export const pendingPatches = new Map<string, { targetUri: vscode.Uri, patchedContent: string, autoStage: boolean }>();

/**
 * Queue for sequential patch processing.
 */
interface QueuedPatch {
  fileUri: vscode.Uri;
  original: string;
  patched: string;
  relPath: string;
  isNew: boolean;
  autoStage: boolean;
  strategy?: string;
}

const patchQueue: QueuedPatch[] = [];

/* ────────────────────── Multi‑file entry point ─────────────────────────── */

export async function applyPatch(
  patchText: string,
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  trackEvent('apply_patch_start', { preview: opts.preview ?? true });

  const cfg = vscode.workspace.getConfiguration('patchPilot');
  const autoStage = opts.autoStage ?? cfg.get('autoStage', false);
  const fuzz = (opts.fuzz ?? cfg.get('fuzzFactor', 2)) as 0 | 1 | 2 | 3;
  const preview = opts.preview ?? true;
  const mtimeCheck = opts.mtimeCheck ?? cfg.get('mtimeCheck', true);

  const canonical = normalizeDiff(patchText);
  const patches = DiffLib.parsePatch(canonical) as DiffParsedPatch[];
  if (patches.length === 0) {
    throw new Error('No valid patches found in the provided text.');
  }

  const results: ApplyResult[] = [];
  const staged: string[] = [];
  
  // Clear queue at start of new operation
  patchQueue.length = 0;

  for (const patch of patches) {
    const relPath = extractFilePath(patch) ?? 'unknown-file';

    try {
      const { uri: fileUri, isNew } = await resolveWorkspaceFile(relPath);
      console.debug(`[DEBUG] File: ${relPath}, isNew: ${isNew}, URI: ${fileUri.toString()}`);

      // Record file stats before reading to detect external changes
      let fileStats: vscode.FileStat | undefined;
      if (mtimeCheck && !isNew) {
        try {
          fileStats = await vscode.workspace.fs.stat(fileUri);
        } catch (_err) {
          // If stat fails, continue anyway but without mtime check
          getOutputChannel().appendLine(`Could not get file stats for ${relPath}, skipping mtime check`);
        }
      }

      let original = '';
      if (!isNew) {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        original = doc.getText();
      }

      const { patched, success, strategy } = await applyPatchToContent(
        original,
        patch,
        fuzz,
      );
      console.debug(`[DEBUG] Patch applied? ${success}, Strategy: ${strategy}`);

      if (!success) {
        results.push({
          file: relPath,
          status: 'failed',
          reason: 'Patch could not be applied',
        });
        continue;
      }

      if (preview) {
        // Add to queue instead of showing immediately
        patchQueue.push({
          fileUri,
          original,
          patched,
          relPath,
          isNew,
          autoStage,
          strategy: strategy || 'preview'
        });
        
        // Mark as 'applied' in terms of "successfully processed", waiting for user acceptance
        results.push({ file: relPath, status: 'applied', strategy: strategy || 'preview' });
        continue;
      }

      // Check if file was modified externally while we were working
      if (mtimeCheck && fileStats && !isNew) {
        try {
          const currentStats = await vscode.workspace.fs.stat(fileUri);
          
          // Compare mtimes directly
          if (fileStats.mtime !== currentStats.mtime) {
            const confirmOverwrite = await vscode.window.showWarningMessage(
              `File ${relPath} has been modified since reading it. Apply patch anyway?`,
              { modal: true },
              'Apply Anyway',
              'Cancel'
            );
            
            if (confirmOverwrite !== 'Apply Anyway') {
              results.push({
                file: relPath,
                status: 'failed',
                reason: 'File modified externally, update aborted'
              });
              continue;
            }
          }
        } catch (_err) {
          getOutputChannel().appendLine(`Could not verify file stats for ${relPath}`);
        }
      }

      if (isNew) {
        console.debug(`[DEBUG] Creating directory for new file: ${fileUri.fsPath}`);
        // Ensure parent directory exists before writing file
        const parentDir = vscode.Uri.joinPath(fileUri, '..');
        await vscode.workspace.fs.createDirectory(parentDir);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(patched));
      } else {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(fileUri, fullDocRange(doc), patched);
        if (!(await vscode.workspace.applyEdit(edit))) {
          results.push({
            file: relPath,
            status: 'failed',
            reason: 'Workspace edit failed',
          });
          continue;
        }
      }

      if (!isNew) {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        if (doc.isDirty) {await doc.save();}
      }
      
      results.push({ file: relPath, status: 'applied', strategy });
      if (autoStage) {staged.push(relPath);}
    } catch (err) {
      results.push({
        file: relPath,
        status: 'failed',
        reason: (err as Error).message ?? String(err),
      });
    }
  }
  
  // Start processing the queue if we have items
  if (patchQueue.length > 0) {
    await processNextPatch();
  }

  if (autoStage && staged.length) {
    try {
      await autoStageFiles(staged);
    } catch (_e) {
      vscode.window.showWarningMessage(
        `Patch applied but Git staging failed: ${(_e as Error).message}`,
      );
    }
  }

  trackEvent('apply_patch_complete', {
    files: results.length,
    success: results.filter((r) => r.status === 'applied').length,
    fuzz,
    mtimeCheck
  });

  return results;
}

/* ───────────────────── Single‑file helper (strategy chain) ─────────────── */

export async function applyPatchToContent(
  content: string,
  patch: DiffParsedPatch,
  fuzz: 0 | 1 | 2 | 3,
): Promise<PatchResult> {
  // Check if the patch is large - could be performance intensive
  const isLargePatch = patch.hunks.length > 5 || content.length > 100000;
  const isLargeFile = content.length > 500000; // ~500KB
  
  if (isLargePatch || isLargeFile) {
    // Use optimized strategies for large patches or files
    // This enhances performance with potentially large diffs
    trackEvent('patch_content', { 
      strategy: 'optimized', 
      hunkCount: patch.hunks.length,
      contentSize: content.length
    });
    
    // Create the standard strategy first
    const standardStrategy = PatchStrategyFactory.createDefaultStrategy(fuzz);
    // Then wrap it with optimized strategies that handle large files better
    const optimizedStrategy = useOptimizedStrategies(standardStrategy, fuzz);
    
    return optimizedStrategy.apply(content, patch);
  } else {
    // Use standard strategies for normal patches
    trackEvent('patch_content', { 
      strategy: 'standard', 
      hunkCount: patch.hunks.length,
      contentSize: content.length
    });
    
    return PatchStrategyFactory.createDefaultStrategy(fuzz).apply(content, patch);
  }
}

/* ───────────────────────── Preview diff editor ─────────────────────────── */

export async function processNextPatch(): Promise<void> {
  const next = patchQueue.shift();
  
  if (!next) {
    getOutputChannel().appendLine('All files from patch have been processed.');
    // Delay message slightly to ensure UI has settled after closing the editor
    setTimeout(() => {
      vscode.window.showInformationMessage('All files from patch have been processed.');
    }, 200);
    return;
  }

  await showNonBlockingDiff(
    next.fileUri,
    next.original,
    next.patched,
    next.relPath,
    next.isNew,
    next.autoStage
  );
}

async function showNonBlockingDiff(
  fileUri: vscode.Uri,
  original: string,
  patched: string,
  relPath: string,
  isNew: boolean,
  autoStage: boolean
): Promise<void> {
  // Left side:
  // If existing file -> use the real file URI (allows editing/copying from left)
  // If new file -> use a virtual empty document
  const leftUri = isNew 
    ? fileUri.with({ scheme: 'patchpilot-orig', query: 'new' }) 
    : fileUri;

  // Right side:
  // Virtual document with the patched content
  const rightUri = fileUri.with({
    scheme: 'patchpilot-mod',
    query: JSON.stringify({ ts: Date.now() }) // Unique query to ensure refresh/separation
  });

  // Store state for the "Accept" command
  pendingPatches.set(rightUri.toString(), { 
    targetUri: fileUri, 
    patchedContent: patched,
    autoStage 
  });

  await vscode.commands.executeCommand(
    'vscode.diff',
    leftUri,
    rightUri,
    `Patch: ${relPath} ${isNew ? '(New File)' : ''} (Click checkmark to accept)`,
    { preview: false }
  );
}

/* ─────────────────────────── Utility helpers ───────────────────────────── */

export function extractFilePath(p: DiffParsedPatch): string | undefined {
  if (p.newFileName && p.newFileName !== '/dev/null') {
    // Clean both actual control characters and escaped character sequences
    return p.newFileName.replace(/^b\//, '')
      .replaceAll(/[\x00-\x1F\x7F]+/g, '') // Remove actual control characters
      .replaceAll(/\\r|\\n/g, '')          // Remove escaped \r and \n sequences
      .trim();
  }
  if (p.oldFileName && p.oldFileName !== '/dev/null') {
    // Clean both actual control characters and escaped character sequences
    return p.oldFileName.replace(/^a\//, '')
      .replaceAll(/[\x00-\x1F\x7F]+/g, '') // Remove actual control characters
      .replaceAll(/\\r|\\n/g, '')          // Remove escaped \r and \n sequences
      .trim();
  }
  return undefined;
}

async function resolveWorkspaceFile(
  relPath: string,
): Promise<{ uri: vscode.Uri, isNew: boolean }> {

  console.debug("DEBUG: relPath", relPath);
  const roots = vscode.workspace.workspaceFolders;
  if (!roots?.length) {throw new Error('No workspace folder open.');}

  // Security improvement: Validate the relative path
  if (!relPath || relPath.includes('..') || relPath.startsWith('/')) {
    throw new Error(`Invalid file path: ${relPath}`);
  }

  // Try each workspace folder
  for (const r of roots) {
    const uri = vscode.Uri.joinPath(r.uri, relPath);
    //console.error("DEBUG: uri: ", uri);
    try {
      await vscode.workspace.fs.stat(uri);
      //console.error("DEBUG: uri2: ", uri);
      return { uri, isNew: false };
    } catch {
      /* ignore */
    }
  }

  // 2. Fuzzy search for existing file
  const fname = relPath.split('/').pop() ?? relPath;
  if (fname && fname !== '' && fname !== '..' && fname !== '.') {
    const found = await vscode.workspace.findFiles(
      `**/${fname}`,
      '**/node_modules/**',
      10
    );

    console.debug("DEBUG: found: ", found);

    if (found.length === 1) { return { uri: found[0], isNew: false }; }
    if (found.length > 1) {
        // Logic for multiple matches could be here, but for now let's default to creation 
        // or just return the first one to keep signature simple, or assume new.
        // To keep behavior close to original but safe:
        return { uri: found[0], isNew: false };
    }
  }

  // 3. Not found -> Assume new file in the first workspace root
  // We default to the first root for creation
  const newFileUri = vscode.Uri.joinPath(roots[0].uri, relPath);
  return { uri: newFileUri, isNew: true };
}

function fullDocRange(doc: vscode.TextDocument): vscode.Range {
  const lastLine = doc.lineCount - 1;
  return new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
}

/* ───────────────────── Parse‑only helper for WebView ───────────────────── */

export async function parsePatch(patchText: string): Promise<FileInfo[]> {
  const cleanPatchText = patchText.replace(/\\r\n|\\r|\n/g, '\n');
  
  const normalized = normalizeDiff(cleanPatchText);
  const patches = DiffLib.parsePatch(normalized) as DiffParsedPatch[];

  const info: FileInfo[] = [];

  // Performance enhancement: pre-check all files first to avoid redundant workspace queries
  const filePathMap = new Map<string, boolean>(); // Map of file path to existence status
  
  for (const p of patches) {
    const path = extractFilePath(p);
    if (!path) {continue;}
    
    // Skip duplicate paths
    if (filePathMap.has(path)) {continue;}
    
    // Check if file exists
    const { isNew } = await resolveWorkspaceFile(path);
    filePathMap.set(path, !isNew);
  }

  // Now process each patch with the pre-checked file existence status
  for (const p of patches) {
    const path = extractFilePath(p);
    if (!path) {continue;}

    let add = 0;
    let del = 0;

    p.hunks.forEach((h) =>
      h.lines.forEach((l) => {
        if (l.startsWith('+')) {add += 1;}
        else if (l.startsWith('-')) {del += 1;}
      }),
    );

    info.push({
      filePath: path,
      exists: filePathMap.get(path) ?? false,
      hunks: p.hunks.length,
      changes: { additions: add, deletions: del },
    });
  }
  return info;
}