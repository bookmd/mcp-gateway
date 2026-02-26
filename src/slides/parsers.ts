/**
 * Slides API parsers
 * Extract content from Google Slides presentations including images, videos, and text
 */
import { slides_v1 } from 'googleapis';
import type { 
  SlideContent, 
  SlideImage, 
  SlideVideo, 
  SlideShape, 
  SlideTable,
  PresentationMetadata,
  PresentationContent 
} from './types.js';

/**
 * Extract text from a text element
 */
function extractTextFromElement(textElements: slides_v1.Schema$TextElement[] | undefined): string {
  if (!textElements) return '';
  
  let text = '';
  for (const element of textElements) {
    if (element.textRun?.content) {
      text += element.textRun.content;
    }
  }
  return text.trim();
}

/**
 * Extract text from a shape
 */
function extractShapeText(shape: slides_v1.Schema$Shape): string {
  if (!shape.text?.textElements) return '';
  return extractTextFromElement(shape.text.textElements);
}

/**
 * Parse an image element
 */
function parseImage(element: slides_v1.Schema$PageElement): SlideImage | null {
  if (!element.image) return null;
  
  const image = element.image;
  const size = element.size;
  
  return {
    objectId: element.objectId || '',
    contentUrl: image.contentUrl || undefined,
    sourceUrl: image.sourceUrl || undefined,
    description: element.description || undefined,
    width: size?.width?.magnitude ?? undefined,
    height: size?.height?.magnitude ?? undefined
  };
}

/**
 * Parse a video element
 */
function parseVideo(element: slides_v1.Schema$PageElement): SlideVideo | null {
  if (!element.video) return null;
  
  const video = element.video;
  
  return {
    objectId: element.objectId || '',
    videoUrl: video.url || undefined,
    source: video.source || undefined,
    id: video.id || undefined
  };
}

/**
 * Parse a shape element
 */
function parseShape(element: slides_v1.Schema$PageElement): SlideShape | null {
  if (!element.shape) return null;
  
  const shape = element.shape;
  const text = extractShapeText(shape);
  
  return {
    objectId: element.objectId || '',
    shapeType: shape.shapeType || undefined,
    text: text || undefined
  };
}

/**
 * Parse a table element
 */
function parseTable(element: slides_v1.Schema$PageElement): SlideTable | null {
  if (!element.table) return null;
  
  const table = element.table;
  const rows = table.rows || 0;
  const columns = table.columns || 0;
  
  const cells: string[][] = [];
  
  if (table.tableRows) {
    for (const row of table.tableRows) {
      const rowCells: string[] = [];
      if (row.tableCells) {
        for (const cell of row.tableCells) {
          let cellText = '';
          if (cell.text?.textElements) {
            cellText = extractTextFromElement(cell.text.textElements);
          }
          rowCells.push(cellText);
        }
      }
      cells.push(rowCells);
    }
  }
  
  return {
    objectId: element.objectId || '',
    rows,
    columns,
    cells
  };
}

/**
 * Extract speaker notes from a slide
 */
function extractSpeakerNotes(slide: slides_v1.Schema$Page): string {
  const notesPage = slide.slideProperties?.notesPage;
  if (!notesPage?.pageElements) return '';
  
  for (const element of notesPage.pageElements) {
    if (element.shape?.placeholder?.type === 'BODY') {
      return extractShapeText(element.shape);
    }
  }
  
  return '';
}

/**
 * Extract title from a slide
 */
function extractSlideTitle(slide: slides_v1.Schema$Page): string | undefined {
  if (!slide.pageElements) return undefined;
  
  for (const element of slide.pageElements) {
    if (element.shape?.placeholder?.type === 'TITLE' || 
        element.shape?.placeholder?.type === 'CENTERED_TITLE') {
      const title = extractShapeText(element.shape);
      if (title) return title;
    }
  }
  
  return undefined;
}

/**
 * Parse a single slide into SlideContent
 */
export function parseSlide(slide: slides_v1.Schema$Page, slideIndex: number): SlideContent {
  const images: SlideImage[] = [];
  const videos: SlideVideo[] = [];
  const shapes: SlideShape[] = [];
  const tables: SlideTable[] = [];
  const textContent: string[] = [];
  
  if (slide.pageElements) {
    for (const element of slide.pageElements) {
      // Parse images
      const image = parseImage(element);
      if (image) {
        images.push(image);
        continue;
      }
      
      // Parse videos
      const video = parseVideo(element);
      if (video) {
        videos.push(video);
        continue;
      }
      
      // Parse tables
      const table = parseTable(element);
      if (table) {
        tables.push(table);
        continue;
      }
      
      // Parse shapes (including text boxes)
      const shape = parseShape(element);
      if (shape) {
        shapes.push(shape);
        if (shape.text) {
          textContent.push(shape.text);
        }
      }
    }
  }
  
  return {
    objectId: slide.objectId || '',
    slideIndex,
    title: extractSlideTitle(slide),
    text: textContent,
    speakerNotes: extractSpeakerNotes(slide) || undefined,
    images,
    videos,
    shapes,
    tables
  };
}

/**
 * Parse presentation metadata
 */
export function parseMetadata(presentation: slides_v1.Schema$Presentation): PresentationMetadata {
  const pageSize = presentation.pageSize;
  
  return {
    presentationId: presentation.presentationId || '',
    title: presentation.title || 'Untitled Presentation',
    locale: presentation.locale || undefined,
    slideCount: presentation.slides?.length || 0,
    pageSize: pageSize ? {
      width: pageSize.width?.magnitude || 0,
      height: pageSize.height?.magnitude || 0,
      unit: pageSize.width?.unit || 'EMU'
    } : undefined
  };
}

/**
 * Parse full presentation into PresentationContent
 */
export function parsePresentation(presentation: slides_v1.Schema$Presentation): PresentationContent {
  const metadata = parseMetadata(presentation);
  const slides: SlideContent[] = [];
  
  if (presentation.slides) {
    presentation.slides.forEach((slide, index) => {
      slides.push(parseSlide(slide, index));
    });
  }
  
  return {
    metadata,
    slides
  };
}
