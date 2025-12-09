/* --------------------------------------------------------------------------
 *  PatchPilot — Utility functions
 * ----------------------------------------------------------------------- */

import * as crypto from 'crypto';
import { sanitizePath } from './security/pathSanitizer';

/**
 * Generates a cryptographically secure nonce string for Content Security Policy
 * @returns A random nonce string
 */
export function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Normalizes line endings to LF
 * @param text The text to normalize
 * @returns Text with normalized line endings
 */
export function normalizeLineEndings(text: string): string {
  return text.replaceAll(/\r\n|\r/g, '\n');
}

/**
 * Auto-fixes spaces in context lines of a diff
 * Missing leading spaces on context lines are added
 * @param diffText The diff text to fix
 * @returns Fixed diff text
 */
export function autoFixSpaces(diffText: string): string {
  return diffText
    .split('\n')
    .map(line => {
      // If line is neither a diff header, nor starts with '+', '-', ' ', or '@'
      // then it's likely a context line missing a leading space
      // Updated to include common git metadata lines to avoid corrupting them
      if (line.trim() !== '' && !/^(\+|-| |@|diff |index |---|(\+\+\+)|@@|new file|deleted file|old mode|new mode|similarity index|copy |rename |binary |\\)/.test(line)) {
        return ' ' + line;
      }
      return line;
    })
    .join('\n');
}

/**
 * Adds missing diff headers if they don't exist
 * @param diffText The diff text to fix
 * @returns Diff text with headers
 */
export function addMissingHeaders(diffText: string): string {
  // If the diff doesn't start with a diff header, add dummy headers
  if (!diffText.trim().startsWith('diff ')) {
    // Extract file path from the first +++ line if possible
    const fileMatch = diffText.match(/\+\+\+ b\/(.+)/);
    const filePath = fileMatch ? fileMatch[1] : 'unknown-file';
    
    const header = [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`
    ].join('\n');
    
    // Check if we already have --- and +++ lines
    if (!diffText.includes('--- ') && !diffText.includes('+++ ')) {
      return header + '\n' + diffText;
    }
    
    // If we have +++ but no ---, add just the diff and --- lines
    if (!diffText.includes('--- ') && diffText.includes('+++ ')) {
      return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n` + diffText;
    }
  }
  
  return diffText;
}

/**
 * Adjusts hunk headers (@@ -old,count +new,count @@) to match the actual number of lines in the hunk.
 * This fixes issues where AI generates incorrect line counts, causing the parser to crash.
 * @param diffText The diff text to adjust
 * @returns Diff text with corrected hunk headers
 */
export function adjustHunkHeaders(diffText: string): string {
  const lines = diffText.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Regex to match standard hunk headers: @@ -1,2 +3,4 @@
    // Captures: 1=oldStart, 2=oldLines(opt), 3=newStart, 4=newLines(opt), 5=trailing
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);

    if (match) {
      let oldLines = 0;
      let newLines = 0;
      
      // Look ahead to count actual lines until the next hunk or file header
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        
        // Stop at next header or hunk
        if (nextLine.startsWith('diff --git') || nextLine.startsWith('@@ ')) {
          break;
        }
        
        if (nextLine.startsWith('-')) {
          oldLines++;
        } else if (nextLine.startsWith('+')) {
          newLines++;
        } else if (nextLine.startsWith(' ')) {
          oldLines++;
          newLines++;
        }
        // Ignore lines that don't start with +,-,space (metadata or garbage)
        j++;
      }

      const oldStart = match[1];
      const newStart = match[3];
      const trailing = match[5] || '';

      // Reconstruct header with calculated counts
      result.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${trailing}`);
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

/**
 * Normalizes a diff by fixing common issues
 * @param diffText The raw diff text
 * @returns Normalized diff
 */
export function normalizeDiff(diffText: string): string {
  // First, normalize actual line endings
  let normalized = normalizeLineEndings(diffText);
  
  normalized = autoFixSpaces(normalized);
  normalized = addMissingHeaders(normalized);
  return normalized;
}

/**
 * Extracts file names from a diff header
 * @param diffHeader The diff header line
 * @returns Object with old and new file names
 */
export function extractFileNamesFromHeader(diffHeader: string): { oldFile?: string; newFile?: string } {
  // diff --git a/path/to/file.txt b/path/to/file.txt
  const gitHeaderMatch = diffHeader.match(/^diff --git a\/(.*) b\/(.*)$/);
  if (gitHeaderMatch) {
    // Clean both actual control characters and escaped character sequences
    const oldFile = sanitizePath(gitHeaderMatch[1]);
    const newFile = sanitizePath(gitHeaderMatch[2]);
    return { oldFile, newFile };
  }
  
  return { oldFile: undefined, newFile: undefined };
}

/**
 * Checks if a string is a valid unified diff
 * @param text Text to check
 * @returns True if the text appears to be a unified diff
 */
export function isUnifiedDiff(text: string): boolean {
  if (!text || text.trim() === '') {
    return false;
  }
  
  // Look for common diff markers
  const hasDiffMarker = text.includes('diff --git') || 
                       text.includes('--- ') || 
                       text.includes('+++ ');
  
  // Look for hunk headers with proper format
  const hasHunkHeader = /@@ -\d+,\d+ \+\d+,\d+ @@/.test(text);
  
  // Look for multiple lines starting with +/- to detect diff content
  // Count the number of lines that start with + or -
  const lines = text.split('\n');
  const plusMinusLines = lines.filter(line => /^[+\-]/.test(line.trim()));
  
  // If there are multiple +/- lines, it's likely a diff
  const hasMultiplePlusMinusLines = plusMinusLines.length >= 2;
  
  // Return true if any of these patterns match
  return hasDiffMarker || hasHunkHeader || hasMultiplePlusMinusLines;
}

/**
 * Creates a debounced function
 * @param func The function to debounce
 * @param wait Wait time in milliseconds
 * @returns Debounced function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  
  return function(this: unknown, ...args: Parameters<T>): void {
    const context = this;
    const later = () => {
      timeout = null;
      func.apply(context, args);
    };
    
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}

/**
 * Throttles a function to only execute at most once per specified interval
 * @param func The function to throttle
 * @param limit Limit in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  
  return function(this: unknown, ...args: Parameters<T>): void {
    const context = this;
    if (!inThrottle) {
      func.apply(context, args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}