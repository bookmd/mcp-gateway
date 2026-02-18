/**
 * Drive API response parsers
 * Converts Google Drive API responses to internal types
 */
import type { drive_v3 } from 'googleapis';
import type { DriveFileSummary } from './types.js';

/**
 * Parse Drive file metadata to summary
 */
export function parseFileMetadata(file: drive_v3.Schema$File): DriveFileSummary {
  return {
    id: file.id || '',
    name: file.name || 'Untitled',
    mimeType: file.mimeType || 'application/octet-stream',
    size: file.size ? parseInt(file.size, 10) : undefined,
    modifiedTime: file.modifiedTime || '',
    webViewLink: file.webViewLink || '',
    parents: file.parents || undefined
  };
}

/**
 * Get export MIME type for Google Workspace files
 * Maps Google-specific MIME types to export formats
 */
export function getExportMimeType(googleMimeType: string): string {
  const exportMap: Record<string, string> = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain'
  };

  return exportMap[googleMimeType] || 'text/plain';
}

/**
 * Check if file is a Google Workspace file (requires export, not download)
 */
export function isGoogleWorkspaceFile(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.');
}

/**
 * Check if file is text-based and can be read as UTF-8
 */
export function isTextFile(mimeType: string): boolean {
  // Text MIME types
  if (mimeType.startsWith('text/')) {
    return true;
  }

  // Common text-based application types
  const textApplicationTypes = [
    'application/json',
    'application/javascript',
    'application/xml',
    'application/x-yaml',
    'application/x-sh',
    'application/x-httpd-php'
  ];

  return textApplicationTypes.includes(mimeType);
}

/**
 * Check if file is an Excel file (.xlsx or .xls)
 */
export function isExcelFile(mimeType: string): boolean {
  const excelMimeTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel', // .xls
  ];
  return excelMimeTypes.includes(mimeType);
}
