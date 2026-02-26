import {
  App,
  Notice,
  TFile,
  requestUrl,
  RequestUrlParam,
  FileSystemAdapter,
} from 'obsidian';
import { MarkerSettings } from './../settings';
import { BaseConverter, ConversionResult } from './../converter';
import { deleteOriginalFile } from '../utils/fileUtils';
import { ConverterSettingDefinition } from '../utils/converterSettingsUtils';

interface GLMOCRSuccessResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface GLMOCRErrorResponse {
  error?: {
    message: string;
    type: string;
  };
  message?: string;
}

export class GLMOCRConverter extends BaseConverter {
  async convert(
    app: App,
    settings: MarkerSettings,
    file: TFile
  ): Promise<boolean> {
    const folderPath = await this.prepareConversion(settings, file);
    if (!folderPath) return false;

    const fileExt = file.name.toLowerCase().split('.').pop();
    const isPDF = fileExt === 'pdf';
    
    if (isPDF) {
      new Notice('Converting PDF with GLM-OCR (this may take a while)...', 15000);
    } else {
      new Notice('Converting file with GLM-OCR...', 10000);
    }

    try {
      let response;
      const fileData = await app.vault.readBinary(file);
      const glmocrEndpoint = settings.glmocrEndpoint || 'localhost:8080';
      
      // For PDFs, try using multipart form-data approach
      if (isPDF) {
        // Generate boundary
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
        const parts = [];
        
        // Add the file
        parts.push(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`
        );
        parts.push(new Uint8Array(fileData));
        parts.push('\r\n');
        
        // Add the prompt
        parts.push(
          `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="prompt"\r\n\r\n' +
          'Extract all text from this document. Preserve the structure, tables, and formatting as much as possible.\r\n'
        );
        
        parts.push(`--${boundary}--\r\n`);
        
        // Combine all parts
        const bodyParts = [];
        for (const part of parts) {
          if (typeof part === 'string') {
            bodyParts.push(new TextEncoder().encode(part));
          } else {
            bodyParts.push(part);
          }
        }
        
        // Calculate total length
        let totalLength = 0;
        for (const part of bodyParts) {
          totalLength += part.length;
        }
        
        // Combine into single Uint8Array
        const body = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of bodyParts) {
          body.set(part, offset);
          offset += part.length;
        }
        
        const requestParams: RequestUrlParam = {
          url: `http://${glmocrEndpoint}/v1/chat/completions`,
          method: 'POST',
          throw: false,
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body: body,
        };
        
        response = await requestUrl(requestParams);

      } else {
        // For non-PDF files (images), use base64 approach
        const base64 = this.arrayBufferToBase64(fileData);
        const mimeType = this.getMimeType(file.name);
        
        const requestParams: RequestUrlParam = {
          url: `http://${glmocrEndpoint}/chat/completions`,
          method: 'POST',
          throw: false,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'mlx-community/GLM-OCR-bf16',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Extract all text from this image. Preserve the structure and format as much as possible.',
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:${mimeType};base64,${base64}`,
                    },
                  },
                ],
              },
            ],
            max_tokens: 4096,
          }),
        };
        
        response = await requestUrl(requestParams);
      }

      if (response.status !== 200) {
        try {
          const errorData = JSON.parse(response.text) as GLMOCRErrorResponse;
          let errorMsg = `HTTP ${response.status}`;

          if (errorData.error?.message) {
            errorMsg = errorData.error.message;
          } else if (errorData.message) {
            errorMsg = errorData.message;
          }

          console.error('GLM-OCR error response:', errorData);
          new Notice(`GLM-OCR conversion failed: ${errorMsg}`);
          return false;
        } catch (parseErr) {
          console.error(
            `GLM-OCR error: HTTP ${response.status}`,
            response.text
          );
          new Notice(
            `GLM-OCR conversion failed: HTTP ${response.status} - ${
              response.text
                ? response.text.substring(0, 100)
                : 'No response details'
            }`
          );
          return false;
        }
      }

      try {
        const responseData = JSON.parse(
          response.text
        ) as GLMOCRSuccessResponse;

        const ocrText =
          responseData.choices?.[0]?.message?.content ||
          'No text extracted';

        const conversionResult: ConversionResult = {
          success: true,
          markdown: ocrText,
          images: {},
          metadata: {
            model: 'GLM-OCR (mlx-vlm)',
            source_file: file.name,
          },
        };

        await this.processConversionResult(
          app,
          settings,
          conversionResult,
          folderPath,
          file
        );
        new Notice('Conversion with GLM-OCR completed');

        if (settings.movePDFtoFolder) {
          const newFilePath = folderPath + file.name;
          await app.vault.rename(file, newFilePath);
        }
        if (settings.deleteOriginal) {
          await deleteOriginalFile(app, file);
        }
        return true;
      } catch (parseError) {
        console.error(
          'Error parsing GLM-OCR response:',
          parseError,
          'Response text:',
          response.text.substring(0, 500) +
            (response.text.length > 500 ? '...' : '')
        );
        new Notice(
          'Error parsing GLM-OCR response. Check console for details.'
        );
        return false;
      }
    } catch (error) {
      console.error('GLM-OCR conversion error:', error.message, error.stack);
      new Notice(
        `GLM-OCR conversion failed: ${
          error.message || 'Network or server error'
        }`
      );
      return false;
    }
  }

  async testConnection(
    settings: MarkerSettings,
    silent: boolean | undefined
  ): Promise<boolean> {
    const glmocrEndpoint = settings.glmocrEndpoint || 'localhost:8080';
    
    try {
      const requestParams: RequestUrlParam = {
        url: `http://${glmocrEndpoint}/models`,
        method: 'GET',
        throw: false,
      };
      const response = await requestUrl(requestParams);
      
      if (response.status === 200) {
        if (!silent) new Notice('GLM-OCR connection successful!');
        return true;
      } else {
        // Try alternative health check endpoint
        try {
          const altRequestParams: RequestUrlParam = {
            url: `http://${glmocrEndpoint}/`,
            method: 'GET',
            throw: false,
          };
          const altResponse = await requestUrl(altRequestParams);
          if (altResponse.status === 200) {
            if (!silent) new Notice('GLM-OCR connection successful!');
            return true;
          }
        } catch {
          // Ignore
        }
        const errorMsg = `HTTP ${response.status}: ${response.text?.substring(0, 100) || 'No response'}`;
        if (!silent) new Notice(`Error: ${errorMsg}`);
        console.error('GLM-OCR connection error:', errorMsg);
        return false;
      }
    } catch (error) {
      const errorMsg = error.message || 'Unknown error';
      if (!silent) new Notice(`Connection failed: ${errorMsg}`);
      console.error('Error connecting to GLM-OCR:', error);
      return false;
    }
  }

  getConverterSettings(): ConverterSettingDefinition[] {
    return [
      {
        id: 'glmocrEndpoint',
        name: 'GLM-OCR Endpoint',
        description:
          'The endpoint for the GLM-OCR mlx-vlm server (e.g., localhost:8080)',
        type: 'text',
        placeholder: 'localhost:8080',
        defaultValue: 'localhost:8080',
        buttonText: 'Test connection',
        buttonAction: async (app, settings) => {
          await this.testConnection(settings, false);
        },
      },
    ];
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop();
    const mimeTypes: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      bmp: 'image/bmp',
      webp: 'image/webp',
      tiff: 'image/tiff',
      tif: 'image/tiff',
    };
    return mimeTypes[ext || ''] || 'application/octet-stream';
  }
}
