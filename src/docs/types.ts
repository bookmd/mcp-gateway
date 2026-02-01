/**
 * Docs API type definitions
 * Defines interfaces for document metadata, content, and results
 */

/**
 * Docs document metadata
 */
export interface DocsDocument {
  id: string;
  title: string;
  documentId: string;
}

/**
 * Docs content (extracted text from document)
 */
export interface DocsContent {
  text: string;  // Extracted text from all tabs
  tabs: number;  // Number of tabs processed
}

/**
 * Result from docs_get_content operation
 */
export interface DocsGetResult {
  document: DocsDocument;
  content: DocsContent;
}

/**
 * Docs API error result
 */
export interface DocsErrorResult {
  error: string;
  code: number;
  message: string;
}
