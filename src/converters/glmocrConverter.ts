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

    new Notice('Converting file with GLM-OCR...', 10000);

    try {
        const adapter = app.vault.adapter;
      let realFilePath = file.path;
      if (adapter instanceof FileSystemAdapter) {
        realFilePath = adapter.getFullPath(file.path);
      } else {
        console.warn(
          'Not using FileSystemAdapter - path may not be correctly resolved'
        );
      }

      const fileData = await app.vault.readBinary(file);
      const base64 = this.arrayBufferToBase64(fileData);
      const mimeType = this.getMimeType(file.name);

      const glmocrEndpoint = settings.glmocrEndpoint || 'localhost:8080';
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
                  text: 'Extract all text from this image or document. Preserve the structure and format as much as possible.',
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

      const response = await requestUrl(requestParams);

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
    try {
      const glmocrEndpoint = settings.glmocrEndpoint || 'localhost:8080';
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
        }
        if (!silent) new Notice(`Error connecting to GLM-OCR: ${response.status}`);
        return false;
      }
    } catch (error) {
      if (!silent) new Notice('Error connecting to GLM-OCR');
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
