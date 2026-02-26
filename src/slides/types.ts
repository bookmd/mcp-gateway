/**
 * Slides API type definitions
 * Defines interfaces for presentation metadata, slides, and content
 */

/**
 * Image element in a slide
 */
export interface SlideImage {
  objectId: string;
  contentUrl?: string;
  sourceUrl?: string;
  description?: string;
  width?: number;
  height?: number;
}

/**
 * Video element in a slide
 */
export interface SlideVideo {
  objectId: string;
  videoUrl?: string;
  source?: string;
  id?: string;
}

/**
 * Shape with text content
 */
export interface SlideShape {
  objectId: string;
  shapeType?: string;
  text?: string;
}

/**
 * Table in a slide
 */
export interface SlideTable {
  objectId: string;
  rows: number;
  columns: number;
  cells: string[][];
}

/**
 * Individual slide content
 */
export interface SlideContent {
  objectId: string;
  slideIndex: number;
  title?: string;
  text: string[];
  speakerNotes?: string;
  images: SlideImage[];
  videos: SlideVideo[];
  shapes: SlideShape[];
  tables: SlideTable[];
}

/**
 * Presentation metadata
 */
export interface PresentationMetadata {
  presentationId: string;
  title: string;
  locale?: string;
  slideCount: number;
  pageSize?: {
    width: number;
    height: number;
    unit: string;
  };
}

/**
 * Full presentation with all slides
 */
export interface PresentationContent {
  metadata: PresentationMetadata;
  slides: SlideContent[];
}

/**
 * Result from slides_get_presentation operation
 */
export interface SlidesGetResult {
  presentation: PresentationContent;
}

/**
 * Result from slides_get_slide operation
 */
export interface SlideGetResult {
  slide: SlideContent;
  presentationTitle: string;
}

/**
 * Result from slides_get_thumbnail operation
 */
export interface SlideThumbnailResult {
  slideObjectId: string;
  thumbnailUrl: string;
  contentUrl: string;
  width: number;
  height: number;
}

/**
 * Slides API error result
 */
export interface SlidesErrorResult {
  error: string;
  code: number;
  message: string;
}
