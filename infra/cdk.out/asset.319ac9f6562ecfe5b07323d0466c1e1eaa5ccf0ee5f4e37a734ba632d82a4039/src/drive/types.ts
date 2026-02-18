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

/**
 * Sheet data from xlsx file
 */
export interface XlsxSheetData {
  name: string;
  data: string[][] | Record<string, unknown>[];
}

/**
 * Result from drive_get_xlsx operation
 */
export interface DriveXlsxResult {
  file: DriveFileSummary;
  sheets: XlsxSheetData[];
  format: 'json' | 'csv' | 'raw';
}

// ============================================
// Write Operation Types
// ============================================

/**
 * Result from drive_upload operation
 */
export interface DriveUploadResult {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  webViewLink: string;
  webContentLink?: string;
}

/**
 * Result from drive_create_folder operation
 */
export interface DriveCreateFolderResult {
  id: string;
  name: string;
  webViewLink: string;
}

/**
 * Result from drive_move operation
 */
export interface DriveMoveResult {
  id: string;
  name: string;
  parents: string[];
}

/**
 * Result from drive_copy operation
 */
export interface DriveCopyResult {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
}

/**
 * Result from drive_rename operation
 */
export interface DriveRenameResult {
  id: string;
  name: string;
}

/**
 * Result from drive_trash operation
 */
export interface DriveTrashResult {
  id: string;
  name: string;
  trashed: boolean;
}

/**
 * Result from drive_delete_permanently operation
 */
export interface DriveDeleteResult {
  id: string;
  deleted: boolean;
}

/**
 * Drive permission
 */
export interface DrivePermission {
  id: string;
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: 'owner' | 'organizer' | 'fileOrganizer' | 'writer' | 'commenter' | 'reader';
  emailAddress?: string;
  displayName?: string;
  domain?: string;
}

/**
 * Result from drive_share operation
 */
export interface DriveShareResult {
  fileId: string;
  permission: DrivePermission;
}

/**
 * Result from drive_get_permissions operation
 */
export interface DrivePermissionsResult {
  fileId: string;
  permissions: DrivePermission[];
}
