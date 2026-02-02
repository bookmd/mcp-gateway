/**
 * Drive API type definitions
 * Defines interfaces for file metadata, content, and results
 */

/**
 * Drive file summary (list/search operations)
 */
export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  size?: number;  // Optional - folders don't have size
  modifiedTime: string;  // ISO 8601 datetime
  webViewLink: string;
  parents?: string[];  // Optional - folder IDs where file lives
}

/**
 * Drive file with content (get operation)
 */
export interface DriveFileContent extends DriveFileSummary {
  content: string | null;  // Text content for supported types, null for binary
  exportFormat?: string;  // MIME type used for export (Google Workspace docs)
}

/**
 * Result from drive_search operation
 */
export interface DriveSearchResult {
  files: DriveFileSummary[];
  nextPageToken: string | null;
}

/**
 * Result from drive_list operation
 */
export interface DriveListResult {
  files: DriveFileSummary[];
  nextPageToken: string | null;
}

/**
 * Result from drive_get_content operation
 */
export interface DriveGetResult {
  file: DriveFileContent;
}

/**
 * Drive API error result
 */
export interface DriveErrorResult {
  error: string;
  code: number;
  message: string;
}
