/**
 * Docs API parsers
 * Extract text content from Google Docs documents
 */
import { docs_v1 } from 'googleapis';
import type { DocsContent } from './types.js';

/**
 * Extract text from a structural element (recursive for tables)
 */
function extractElementText(element: docs_v1.Schema$StructuralElement): string {
  let text = '';

  // Handle paragraph elements
  if (element.paragraph) {
    const paragraph = element.paragraph;
    if (paragraph.elements) {
      for (const elem of paragraph.elements) {
        if (elem.textRun && elem.textRun.content) {
          text += elem.textRun.content;
        }
      }
    }
  }

  // Handle table elements (recursive)
  if (element.table) {
    const table = element.table;
    if (table.tableRows) {
      for (const row of table.tableRows) {
        if (row.tableCells) {
          for (const cell of row.tableCells) {
            if (cell.content) {
              for (const cellElement of cell.content) {
                text += extractElementText(cellElement);
              }
            }
          }
        }
      }
    }
  }

  return text;
}

/**
 * Extract text from document by iterating through all tabs
 * CRITICAL: Google Docs uses tabs structure, not a single body
 */
export function extractText(doc: docs_v1.Schema$Document): string {
  let fullText = '';

  // Iterate through tabs array (docs can have multiple tabs)
  if (doc.tabs) {
    for (const tab of doc.tabs) {
      // Each tab has a documentTab with body content
      if (tab.documentTab && tab.documentTab.body) {
        const body = tab.documentTab.body;
        if (body.content) {
          for (const element of body.content) {
            fullText += extractElementText(element);
          }
        }
      }
    }
  }

  return fullText;
}

/**
 * Parse document into DocsContent structure
 */
export function parseDocument(doc: docs_v1.Schema$Document): DocsContent {
  const text = extractText(doc);
  const tabs = (doc.tabs || []).length;

  return {
    text,
    tabs
  };
}
