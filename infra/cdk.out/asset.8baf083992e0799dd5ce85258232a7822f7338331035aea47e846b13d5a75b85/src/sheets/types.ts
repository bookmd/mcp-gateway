/**
 * Sheets API type definitions
 * Defines interfaces for spreadsheet metadata, cell data, and results
 */

/**
 * Sheets cell data with normalized rows
 */
export interface SheetsData {
  range: string;           // Actual range returned (e.g., "Sheet1!A1:D5")
  rows: any[][];           // Normalized 2D array of cell values (sparse rows padded)
  rowCount: number;        // Number of rows
  columnCount: number;     // Maximum column count (for normalized rows)
  isEmpty: boolean;        // True if no data
}

/**
 * Individual sheet information within a spreadsheet
 */
export interface SheetInfo {
  sheetId: number;         // Sheet ID
  title: string;           // Sheet name
  index: number;           // Sheet position (0-based)
  rowCount: number;        // Number of rows in sheet
  columnCount: number;     // Number of columns in sheet
}

/**
 * Spreadsheet metadata
 */
export interface SheetsMetadata {
  spreadsheetId: string;   // Spreadsheet ID
  title: string;           // Spreadsheet title
  spreadsheetUrl: string;  // Web URL to spreadsheet
  sheets: SheetInfo[];     // Array of sheets in the spreadsheet
}

/**
 * Result from sheets_get_values operation
 */
export interface SheetsGetValuesResult {
  data: SheetsData;
}

/**
 * Result from sheets_get_metadata operation
 */
export interface SheetsGetMetadataResult {
  metadata: SheetsMetadata;
}

/**
 * Sheets API error result
 */
export interface SheetsErrorResult {
  error: string;
  code: number;
  message: string;
}

// ============================================
// Write Operation Types
// ============================================

/**
 * Result from sheets_update_values operation
 */
export interface SheetsUpdateResult {
  spreadsheetId: string;
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

/**
 * Result from sheets_append_row operation
 */
export interface SheetsAppendResult {
  spreadsheetId: string;
  tableRange: string;
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

/**
 * Result from sheets_clear_range operation
 */
export interface SheetsClearResult {
  spreadsheetId: string;
  clearedRange: string;
}

/**
 * Result from sheets_create operation
 */
export interface SheetsCreateResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  sheets: Array<{ sheetId: number; title: string }>;
}

/**
 * Result from sheets_add_sheet operation
 */
export interface SheetsAddSheetResult {
  spreadsheetId: string;
  sheetId: number;
  title: string;
  index: number;
}

/**
 * Result from sheets_delete_sheet operation
 */
export interface SheetsDeleteSheetResult {
  spreadsheetId: string;
  deletedSheetId: number;
  success: boolean;
}

/**
 * Result from sheets_batch_update operation
 */
export interface SheetsBatchUpdateResult {
  spreadsheetId: string;
  replies: any[];
}
