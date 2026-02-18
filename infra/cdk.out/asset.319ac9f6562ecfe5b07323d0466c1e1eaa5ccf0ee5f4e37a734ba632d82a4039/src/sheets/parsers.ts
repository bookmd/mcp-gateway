/**
 * Sheets API parsers
 * Parse Google Sheets API responses into normalized structures
 */
import { sheets_v4 } from 'googleapis';
import type { SheetsData, SheetInfo, SheetsMetadata } from './types.js';

/**
 * Parse value range from Sheets API and normalize sparse data
 * CRITICAL: Pad all rows to maxCols to handle sparse data
 */
export function parseValueRange(result: sheets_v4.Schema$ValueRange): SheetsData {
  const range = result.range || 'Unknown';
  const values = result.values || [];

  // Empty range
  if (values.length === 0) {
    return {
      range,
      rows: [],
      rowCount: 0,
      columnCount: 0,
      isEmpty: true
    };
  }

  // Calculate maximum column count across all rows
  const maxCols = Math.max(...values.map(row => row.length));

  // Normalize rows: pad each row to maxCols with null for missing cells
  const normalizedRows = values.map(row => {
    const normalized = [...row];
    while (normalized.length < maxCols) {
      normalized.push(null);
    }
    return normalized;
  });

  return {
    range,
    rows: normalizedRows,
    rowCount: normalizedRows.length,
    columnCount: maxCols,
    isEmpty: false
  };
}

/**
 * Parse sheet properties into SheetInfo
 */
export function parseSheetProperties(sheet: sheets_v4.Schema$Sheet): SheetInfo {
  const properties = sheet.properties || {};
  const gridProperties = properties.gridProperties || {};

  return {
    sheetId: properties.sheetId ?? 0,
    title: properties.title || 'Untitled Sheet',
    index: properties.index ?? 0,
    rowCount: gridProperties.rowCount ?? 0,
    columnCount: gridProperties.columnCount ?? 0
  };
}

/**
 * Parse spreadsheet metadata
 */
export function parseSpreadsheetMetadata(spreadsheet: sheets_v4.Schema$Spreadsheet): SheetsMetadata {
  const properties = spreadsheet.properties || {};
  const sheets = spreadsheet.sheets || [];

  return {
    spreadsheetId: spreadsheet.spreadsheetId || '',
    title: properties.title || 'Untitled Spreadsheet',
    spreadsheetUrl: spreadsheet.spreadsheetUrl || '',
    sheets: sheets.map(parseSheetProperties)
  };
}
