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

interface GLMOCRMaaSSuccessResponse {
  code: number;
  msg: string;
  data?: {
    md_result?: string;
    json_result?: unknown;
  };
}

interface GLMOCRMaaSErrorResponse {
  code: number;
  msg: string;
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
      new Notice('Converting PDF with GLM-OCR (cloud API)...', 15000);
    } else {
      new Notice('Converting image with GLM-OCR (cloud API)...', 10000);
    }

    try {
      // Get API key from settings
      const apiKey = settings.glmocrApiKey;
      if (!apiKey) {
        new Notice('Error: GLM-OCR API key not configured. Please set it in plugin settings.');
        return false;
      }

      const fileData = await app.vault.readBinary(file);
      const base64 = this.arrayBufferToBase64(fileData);
      const mimeType = this.getMimeType(file.name);
      
      // Create data URI
      const dataUri = `data:${mimeType};base64,${base64}`;

      const requestParams: RequestUrlParam = {
        url: 'https://open.bigmodel.cn/api/paas/v4/layout_parsing',
        method: 'POST',
        throw: false,
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'glm-ocr',
          file: dataUri,
        }),
      };
      
      const response = await requestUrl(requestParams);

      if (response.status !== 200) {
        try {
          const errorData = JSON.parse(response.text) as GLMOCRMaaSErrorResponse;
          const errorMsg = errorData.msg || `HTTP ${response.status}`;
          
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
        ) as GLMOCRMaaSSuccessResponse;

        if (responseData.code !== 0) {
          console.error('GLM-OCR API error:', responseData.msg);
          new Notice(`GLM-OCR conversion failed: ${responseData.msg}`);
          return false;
        }

        // Extract markdown from response
        const ocrText = responseData.data?.md_result || '';
        
        if (!ocrText) {
          console.error('GLM-OCR response has no data:', responseData);
          new Notice('GLM-OCR conversion failed: No text extracted');
          return false;
        }

        const conversionResult: ConversionResult = {
          success: true,
          markdown: ocrText,
          images: {},
          metadata: {
            model: 'GLM-OCR (cloud)',
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
    const apiKey = settings.glmocrApiKey;
    
    if (!apiKey) {
      if (!silent) new Notice('Error: API key not configured');
      return false;
    }
    
    try {
      const requestParams: RequestUrlParam = {
        url: 'https://open.bigmodel.cn/api/paas/v4/models',
        method: 'GET',
        throw: false,
        headers: {
          'Authorization': apiKey,
        },
      };
      const response = await requestUrl(requestParams);
      
      if (response.status === 200) {
        if (!silent) new Notice('GLM-OCR API key valid!');
        return true;
      } else {
        const errorMsg = `HTTP ${response.status}: ${response.text?.substring(0, 100) || 'No response'}`;
        if (!silent) new Notice(`API key error: ${errorMsg}`);
        console.error('GLM-OCR API error:', errorMsg);
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
        id: 'glmocrApiKey',
        name: 'GLM-OCR API Key',
        description:
          'Your Zhipu AI API key. Get it from https://open.bigmodel.cn/usercenter/apikeys',
        type: 'text',
        placeholder: 'Your API key (e.g., your-api-key-here)',
        defaultValue: '',
        buttonText: 'Test API Key',
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
