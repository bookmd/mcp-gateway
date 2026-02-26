/**
 * Slides MCP tool handlers
 * Implements slides_get_presentation, slides_get_slide, slides_get_thumbnail tools
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { UserContext } from '../auth/middleware.js';
import { getUserContextBySessionId } from '../routes/sse.js';
import { createSlidesClient } from './client.js';
import { parsePresentation, parseSlide } from './parsers.js';
import type { SlidesGetResult, SlideGetResult, SlideThumbnailResult } from './types.js';

/**
 * Extract user context from MCP extra parameter using session ID
 */
function getUserContext(extra: any): UserContext | null {
  const sessionId = extra?.sessionId;
  if (!sessionId) return null;
  return getUserContextBySessionId(sessionId) || null;
}

/**
 * Handle Slides API errors and return appropriate MCP response
 */
function handleSlidesError(error: any): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = error.code || error.response?.status || 500;
  const message = error.message || 'Unknown Slides API error';

  // Log the full error for debugging
  console.error('[Slides] API Error:', JSON.stringify({
    code,
    message,
    errorDetails: error.errors || error.response?.data?.error || null,
    fullError: error.toString()
  }));

  if (code === 401) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'token_expired',
          code: 401,
          message: 'Access token expired. Please re-authenticate at /auth/login'
        }, null, 2)
      }],
      isError: true
    };
  }

  if (code === 403) {
    if (message.includes('rate') || message.includes('quota') || message.includes('limit')) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'rate_limited',
            code: 403,
            message: 'Slides API rate limit exceeded. Please wait and try again.'
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'insufficient_scope',
          code: 403,
          message: 'Slides access not authorized. Please re-authenticate at /auth/login to grant Slides permissions.'
        }, null, 2)
      }],
      isError: true
    };
  }

  if (code === 404) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'presentation_not_found',
          code: 404,
          message: 'Presentation not found or you do not have permission to access it.'
        }, null, 2)
      }],
      isError: true
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'slides_api_error',
        code: code,
        message: message
      }, null, 2)
    }],
    isError: true
  };
}

/**
 * Register Slides tools with MCP server
 */
export function registerSlidesHandlers(server: McpServer): void {
  // slides_get_presentation - Get full presentation with all slides, images, and content
  server.registerTool('slides_get_presentation', {
    description: 'Get full Google Slides presentation including all slides, text, images, videos, speaker notes, and structure',
    inputSchema: {
      presentationId: z.string().describe('Presentation ID (from URL or Drive)')
    }
  }, async (args: any, extra: any) => {
    const userContext = getUserContext(extra);
    if (!userContext) {
      return {
        content: [{ type: 'text', text: 'Error: No user context. Please authenticate.' }],
        isError: true
      };
    }

    try {
      const slides = createSlidesClient(userContext);

      const response = await slides.presentations.get({
        presentationId: args.presentationId as string
      });

      const presentation = parsePresentation(response.data);

      const result: SlidesGetResult = {
        presentation
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleSlidesError(error);
    }
  });

  // slides_get_slide - Get a specific slide by index
  server.registerTool('slides_get_slide', {
    description: 'Get a specific slide from a presentation by index (0-based)',
    inputSchema: {
      presentationId: z.string().describe('Presentation ID'),
      slideIndex: z.number().min(0).describe('Slide index (0-based)')
    }
  }, async (args: any, extra: any) => {
    const userContext = getUserContext(extra);
    if (!userContext) {
      return {
        content: [{ type: 'text', text: 'Error: No user context. Please authenticate.' }],
        isError: true
      };
    }

    try {
      const slidesClient = createSlidesClient(userContext);

      const response = await slidesClient.presentations.get({
        presentationId: args.presentationId as string
      });

      const presentation = response.data;
      const slideIndex = args.slideIndex as number;

      if (!presentation.slides || slideIndex >= presentation.slides.length) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'slide_not_found',
              code: 404,
              message: `Slide at index ${slideIndex} not found. Presentation has ${presentation.slides?.length || 0} slides.`
            }, null, 2)
          }],
          isError: true
        };
      }

      const slide = parseSlide(presentation.slides[slideIndex], slideIndex);

      const result: SlideGetResult = {
        slide,
        presentationTitle: presentation.title || 'Untitled Presentation'
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleSlidesError(error);
    }
  });

  // slides_get_thumbnail - Get thumbnail URL for a specific slide
  server.registerTool('slides_get_thumbnail', {
    description: 'Get thumbnail image URL for a specific slide',
    inputSchema: {
      presentationId: z.string().describe('Presentation ID'),
      slideObjectId: z.string().describe('Slide object ID (from slides_get_presentation)'),
      thumbnailSize: z.enum(['SMALL', 'MEDIUM', 'LARGE']).optional().describe('Thumbnail size (default: MEDIUM)')
    }
  }, async (args: any, extra: any) => {
    const userContext = getUserContext(extra);
    if (!userContext) {
      return {
        content: [{ type: 'text', text: 'Error: No user context. Please authenticate.' }],
        isError: true
      };
    }

    try {
      const slidesClient = createSlidesClient(userContext);

      const thumbnailSize = args.thumbnailSize || 'MEDIUM';
      
      const response = await slidesClient.presentations.pages.getThumbnail({
        presentationId: args.presentationId as string,
        pageObjectId: args.slideObjectId as string,
        'thumbnailProperties.thumbnailSize': thumbnailSize
      });

      const thumbnail = response.data;

      const result: SlideThumbnailResult = {
        slideObjectId: args.slideObjectId,
        thumbnailUrl: thumbnail.contentUrl || '',
        contentUrl: thumbnail.contentUrl || '',
        width: thumbnail.width || 0,
        height: thumbnail.height || 0
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleSlidesError(error);
    }
  });

  // slides_list_images - List all images in a presentation with their URLs
  server.registerTool('slides_list_images', {
    description: 'List all images in a presentation with their content URLs for downloading',
    inputSchema: {
      presentationId: z.string().describe('Presentation ID')
    }
  }, async (args: any, extra: any) => {
    const userContext = getUserContext(extra);
    if (!userContext) {
      return {
        content: [{ type: 'text', text: 'Error: No user context. Please authenticate.' }],
        isError: true
      };
    }

    try {
      const slidesClient = createSlidesClient(userContext);

      const response = await slidesClient.presentations.get({
        presentationId: args.presentationId as string
      });

      const presentation = response.data;
      const images: Array<{
        slideIndex: number;
        slideObjectId: string;
        imageObjectId: string;
        contentUrl?: string;
        sourceUrl?: string;
        description?: string;
        width?: number;
        height?: number;
      }> = [];

      if (presentation.slides) {
        presentation.slides.forEach((slide, slideIndex) => {
          if (slide.pageElements) {
            for (const element of slide.pageElements) {
              if (element.image) {
                images.push({
                  slideIndex,
                  slideObjectId: slide.objectId || '',
                  imageObjectId: element.objectId || '',
                  contentUrl: element.image.contentUrl || undefined,
                  sourceUrl: element.image.sourceUrl || undefined,
                  description: element.description || undefined,
                  width: element.size?.width?.magnitude ?? undefined,
                  height: element.size?.height?.magnitude ?? undefined
                });
              }
            }
          }
        });
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            presentationId: args.presentationId,
            presentationTitle: presentation.title || 'Untitled Presentation',
            totalImages: images.length,
            images
          }, null, 2)
        }]
      };
    } catch (error) {
      return handleSlidesError(error);
    }
  });

  console.log('[MCP] Slides handlers registered: slides_get_presentation, slides_get_slide, slides_get_thumbnail, slides_list_images');
}
