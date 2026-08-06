import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnDestroy, OnInit, QueryList, ViewChild, ViewChildren } from '@angular/core';
import { FormsModule } from '@angular/forms';

type Rgb = {
  r: number;
  g: number;
  b: number;
};

type PaletteEntry = Rgb & {
  hex: string;
  count: number;
  symbol: string;
};

type PatternBuildResult = {
  grid: number[][];
  palette: PaletteEntry[];
  error?: string;
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('patternCanvas')
  patternCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('patternPanel')
  patternPanel?: ElementRef<HTMLElement>;
  @ViewChild('cropCanvas')
  cropCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChildren('pickerHost')
  pickerHosts?: QueryList<ElementRef<HTMLElement>>;
  @ViewChildren('editButton')
  editButtons?: QueryList<ElementRef<HTMLButtonElement>>;

  title = 'Generador de Patron Punto Cruz';
  imageName = '';
  sourcePreview = '';
  sourceImage: HTMLImageElement | null = null;
  isProcessing = false;

  stitchColumns =25;
  maxColors = 6;
  stitchSize = 30;
  preserveOriginalColors = false;
  generationError = '';
  showSymbols = true;
  showGuideGrid = false;
  guideDensity = 10;
  rowGuideLabelMode: 'numbers' | 'letters' = 'numbers';
  colGuideLabelMode: 'numbers' | 'letters' = 'numbers';
  editingColorIndex: number | null = null;
  showCropModalOnLoad = true;
  isCropModalOpen = false;

  private readonly cropCookieName = 'cross_stitch_crop_modal';
  private pendingImageName = '';
  private pendingSourceImage: HTMLImageElement | null = null;
  private cropImageBounds = { x: 0, y: 0, width: 0, height: 0, scale: 1 };
  private cropSelection = { x: 0, y: 0, width: 0, height: 0 };
  private activeCropEdge: 'left' | 'right' | 'top' | 'bottom' | null = null;
  private cropDragActive = false;
  cropInsets = { left: 0, right: 0, top: 0, bottom: 0 };
  hasLightBackground = false;
  useTextureBackground = false;
  texturePreview = '';
  textureImage: HTMLImageElement | null = null;
  activeTextureBackground: HTMLImageElement | null = null;
  stitchCount = 0;

  patternWidth = 0;
  patternHeight = 0;
  grid: number[][] = [];
  palette: PaletteEntry[] = [];
  colorDrafts: string[] = [];
  readonly symbols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#%&*+=?<>'.split('');
  private readonly maxExactColors = 30;
  private pickerInstance: any = null;
  private pickerIndex: number | null = null;

  ngOnInit(): void {
    const cookieValue = this.readCookie(this.cropCookieName);
    this.showCropModalOnLoad = cookieValue === null ? true : cookieValue === '1';
  }

  ngOnDestroy(): void {
    this.destroyLibraryColorPicker();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    this.imageName = file.name;
    this.clearGeneratedOutput();
    const reader = new FileReader();

    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';

      if (!result) {
        return;
      }

      this.sourcePreview = result;
      const image = new Image();
      image.onload = () => {
        if (this.showCropModalOnLoad) {
          this.openCropModal(file.name, image);
          return;
        }

        this.activeTextureBackground = null;
        this.sourceImage = image;
      };
      image.src = result;
    };

    reader.readAsDataURL(file);
  }

  onCropPreferenceToggle(): void {
    this.writeCookie(this.cropCookieName, this.showCropModalOnLoad ? '1' : '0', 365);
  }

  onGuideSettingsChange(): void {
    if (this.grid.length === 0) {
      return;
    }

    this.guideDensity = this.clamp(Math.round(this.guideDensity), 2, 80);
    this.renderPatternCanvas();
  }

  onTextureFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        return;
      }

      const image = new Image();
      image.onload = () => {
        this.texturePreview = result;
        this.textureImage = image;
        this.useTextureBackground = this.hasLightBackground;
        this.renderCropCanvas();
      };
      image.src = result;
    };

    reader.readAsDataURL(file);
  }

  clearTextureBackground(): void {
    this.texturePreview = '';
    this.textureImage = null;
    this.useTextureBackground = false;
    this.renderCropCanvas();
  }

  onTextureToggle(): void {
    this.renderCropCanvas();
  }

  onCropPointerDown(event: PointerEvent): void {
    const point = this.getCropCanvasPoint(event);
    if (!point) {
      return;
    }

    const edge = this.detectClosestCropEdge(point.x, point.y);
    if (!edge) {
      return;
    }

    this.activeCropEdge = edge;
    this.cropDragActive = true;
    this.updateCropByEdgePoint(edge, point.x, point.y);

    const canvas = this.cropCanvas?.nativeElement;
    canvas?.setPointerCapture(event.pointerId);
    this.updateCropCanvasCursor(edge);
  }

  onCropPointerMove(event: PointerEvent): void {
    const point = this.getCropCanvasPoint(event);
    if (!point) {
      return;
    }

    if (this.cropDragActive && this.activeCropEdge) {
      this.updateCropByEdgePoint(this.activeCropEdge, point.x, point.y);
      return;
    }

    const edge = this.detectClosestCropEdge(point.x, point.y);
    this.updateCropCanvasCursor(edge);
  }

  onCropPointerUp(event?: PointerEvent): void {
    if (!this.cropDragActive) {
      return;
    }

    const canvas = this.cropCanvas?.nativeElement;
    if (event) {
      canvas?.releasePointerCapture(event.pointerId);
    }

    this.cropDragActive = false;
    this.activeCropEdge = null;
    this.updateCropCanvasCursor(null);
  }

  autoCropFlatBackground(): void {
    const source = this.pendingSourceImage;
    if (!source) {
      return;
    }

    const scan = document.createElement('canvas');
    scan.width = source.width;
    scan.height = source.height;
    const scanCtx = scan.getContext('2d');
    if (!scanCtx) {
      return;
    }

    scanCtx.drawImage(source, 0, 0);
    const { data, width, height } = scanCtx.getImageData(0, 0, source.width, source.height);

    const sampleSize = Math.max(1, Math.floor(Math.min(width, height) * 0.03));
    const cornerSamples = [
      this.samplePatchColor(data, width, height, 0, 0, sampleSize),
      this.samplePatchColor(data, width, height, width - sampleSize, 0, sampleSize),
      this.samplePatchColor(data, width, height, 0, height - sampleSize, sampleSize),
      this.samplePatchColor(data, width, height, width - sampleSize, height - sampleSize, sampleSize)
    ];

    const bg = {
      r: Math.round(cornerSamples.reduce((acc, item) => acc + item.r, 0) / cornerSamples.length),
      g: Math.round(cornerSamples.reduce((acc, item) => acc + item.g, 0) / cornerSamples.length),
      b: Math.round(cornerSamples.reduce((acc, item) => acc + item.b, 0) / cornerSamples.length)
    };

    const threshold = 34;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = (y * width + x) * 4;
        const alpha = data[idx + 3];
        if (alpha < 16) {
          continue;
        }

        const dr = Math.abs(data[idx] - bg.r);
        const dg = Math.abs(data[idx + 1] - bg.g);
        const db = Math.abs(data[idx + 2] - bg.b);
        const dist = dr + dg + db;

        if (dist > threshold) {
          if (x < minX) {
            minX = x;
          }
          if (x > maxX) {
            maxX = x;
          }
          if (y < minY) {
            minY = y;
          }
          if (y > maxY) {
            maxY = y;
          }
        }
      }
    }

    if (maxX < minX || maxY < minY) {
      this.resetCropInsets();
      return;
    }

    const pad = 2;
    minX = this.clamp(minX - pad, 0, width - 1);
    minY = this.clamp(minY - pad, 0, height - 1);
    maxX = this.clamp(maxX + pad, 0, width - 1);
    maxY = this.clamp(maxY + pad, 0, height - 1);

    this.cropInsets.left = Math.round((minX / width) * 100);
    this.cropInsets.right = Math.round(((width - 1 - maxX) / width) * 100);
    this.cropInsets.top = Math.round((minY / height) * 100);
    this.cropInsets.bottom = Math.round(((height - 1 - maxY) / height) * 100);

    this.enforceCropInsetLimits();
    this.renderCropCanvas();
  }

  useFullImage(): void {
    this.resetCropInsets();
    this.applyCrop();
  }

  cancelCrop(): void {
    this.isCropModalOpen = false;
    this.pendingSourceImage = null;
    this.pendingImageName = '';
  }

  applyCrop(shouldGenerate = true): void {
    if (!this.pendingSourceImage) {
      return;
    }

    const source = this.pendingSourceImage;
    let sx = Math.round((source.width * this.cropInsets.left) / 100);
    let sy = Math.round((source.height * this.cropInsets.top) / 100);
    const rightBound = Math.round((source.width * (100 - this.cropInsets.right)) / 100);
    const bottomBound = Math.round((source.height * (100 - this.cropInsets.bottom)) / 100);
    let sw = rightBound - sx;
    let sh = bottomBound - sy;

    sx = this.clamp(sx, 0, source.width - 1);
    sy = this.clamp(sy, 0, source.height - 1);
    sw = this.clamp(sw, 1, source.width - sx);
    sh = this.clamp(sh, 1, source.height - sy);

    const output = document.createElement('canvas');
    output.width = sw;
    output.height = sh;
    const outCtx = output.getContext('2d');

    if (!outCtx) {
      return;
    }

    outCtx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    if (this.useTextureBackground && this.textureImage && this.hasLightBackground) {
      const data = outCtx.getImageData(0, 0, sw, sh);
      const backgroundMask = this.buildConnectedLightMask(data);

      const foregroundCanvas = document.createElement('canvas');
      foregroundCanvas.width = sw;
      foregroundCanvas.height = sh;
      const fgCtx = foregroundCanvas.getContext('2d');

      if (!fgCtx) {
        return;
      }

      const fgData = new ImageData(new Uint8ClampedArray(data.data), sw, sh);
      for (let i = 0; i < backgroundMask.length; i += 1) {
        if (backgroundMask[i] === 1) {
          fgData.data[i * 4 + 3] = 0;
        }
      }
      fgCtx.putImageData(fgData, 0, 0);

      const composedCanvas = document.createElement('canvas');
      composedCanvas.width = sw;
      composedCanvas.height = sh;
      const composedCtx = composedCanvas.getContext('2d');

      if (!composedCtx) {
        return;
      }

      const texturePattern = composedCtx.createPattern(this.textureImage, 'repeat');
      if (texturePattern) {
        composedCtx.fillStyle = texturePattern;
        composedCtx.fillRect(0, 0, sw, sh);
      } else {
        composedCtx.fillStyle = '#ffffff';
        composedCtx.fillRect(0, 0, sw, sh);
      }
      composedCtx.drawImage(foregroundCanvas, 0, 0);

      const composedDataUrl = composedCanvas.toDataURL('image/png');
      const foregroundDataUrl = foregroundCanvas.toDataURL('image/png');
      this.finalizeCroppedImage(foregroundDataUrl, composedDataUrl, this.textureImage, shouldGenerate, foregroundCanvas);
      return;
    }

    const croppedDataUrl = output.toDataURL('image/png');
    this.finalizeCroppedImage(croppedDataUrl, croppedDataUrl, null, shouldGenerate, output);
  }

  generatePattern(): void {
    if (!this.sourceImage) {
      return;
    }

    this.generatePatternFromSource(this.sourceImage);
  }

  private generatePatternFromSource(source: CanvasImageSource & { width: number; height: number }): void {
    this.normalizeGenerationSettings();
    this.generationError = '';

    this.isProcessing = true;

    const cols = this.stitchColumns;
    const ratio = source.height / source.width;
    const rows = Math.max(1, Math.round(cols * ratio));

    this.patternWidth = cols;
    this.patternHeight = rows;

    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = cols;
    sampleCanvas.height = rows;
    const sampleCtx = sampleCanvas.getContext('2d');

    if (!sampleCtx) {
      this.isProcessing = false;
      return;
    }

    sampleCtx.imageSmoothingEnabled = !this.preserveOriginalColors;
    sampleCtx.drawImage(source, 0, 0, cols, rows);
    const imageData = sampleCtx.getImageData(0, 0, cols, rows).data;

    const quantized = this.preserveOriginalColors
      ? this.buildExactPalette(imageData, cols, rows, this.maxExactColors)
      : this.quantize(imageData, cols, rows, this.maxColors);

    if (quantized.error) {
      this.isProcessing = false;
      this.grid = [];
      this.palette = [];
      this.stitchCount = 0;
      this.patternWidth = 0;
      this.patternHeight = 0;
      this.editingColorIndex = null;
      this.colorDrafts = [];
      this.generationError = quantized.error;
      return;
    }

    this.grid = quantized.grid;
    this.palette = quantized.palette;
    this.stitchCount = this.countStitchesInGrid();
    this.editingColorIndex = null;
    this.destroyLibraryColorPicker();
    this.syncColorDrafts();

    this.isProcessing = false;

    if (this.patternCanvas?.nativeElement) {
      this.renderPatternCanvas();
      this.scrollToPattern();
      return;
    }

    requestAnimationFrame(() => {
      this.renderPatternCanvas();
      this.scrollToPattern();
    });
  }

  private normalizeGenerationSettings(): void {
    const parsedCols = Number(this.stitchColumns);
    const parsedColors = Number(this.maxColors);
    const parsedCell = Number(this.stitchSize);

    this.stitchColumns = this.clamp(Number.isFinite(parsedCols) ? Math.round(parsedCols) : 64, 16, 220);
    this.maxColors = this.clamp(Number.isFinite(parsedColors) ? Math.round(parsedColors) : 16, 2, 48);
    this.stitchSize = this.clamp(Number.isFinite(parsedCell) ? Math.round(parsedCell) : 12, 6, 32);
  }

  private clearGeneratedOutput(): void {
    this.generationError = '';
    this.grid = [];
    this.palette = [];
    this.patternWidth = 0;
    this.patternHeight = 0;
    this.stitchCount = 0;
    this.editingColorIndex = null;
    this.colorDrafts = [];
    this.destroyLibraryColorPicker();
  }

  private scrollToPattern(): void {
    setTimeout(() => {
      this.patternPanel?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }

  toggleColorEditor(index: number): void {
    if (!this.isValidPaletteIndex(index)) {
      return;
    }

    if (this.editingColorIndex === index) {
      this.editingColorIndex = null;
      this.destroyLibraryColorPicker();
      return;
    }

    this.editingColorIndex = index;
    if (this.editingColorIndex !== null) {
      this.colorDrafts[index] = this.palette[index].hex;
      requestAnimationFrame(() => {
        void this.mountLibraryColorPicker(index);
      });
    }
  }

  isColorEditorOpen(index: number): boolean {
    return this.editingColorIndex === index;
  }

  applyHexColor(index: number): void {
    if (!this.isValidPaletteIndex(index)) {
      return;
    }

    const draft = (this.colorDrafts[index] ?? '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(draft)) {
      this.colorDrafts[index] = this.palette[index].hex;
      return;
    }

    const rgb = this.hexToRgb(draft);
    if (!rgb) {
      this.colorDrafts[index] = this.palette[index].hex;
      return;
    }

    this.palette[index] = {
      ...this.palette[index],
      ...rgb,
      hex: draft.toUpperCase()
    };

    this.colorDrafts[index] = this.palette[index].hex;
    this.renderPatternCanvas();
  }

  removeColor(sourceIndex: number): void {
    if (!this.isValidPaletteIndex(sourceIndex) || this.palette.length <= 1) {
      return;
    }

    const targetIndex = this.findNearestPaletteIndex(sourceIndex);
    if (targetIndex === -1) {
      return;
    }

    this.remapGridColor(sourceIndex, targetIndex);
    this.rebuildPaletteFromGrid();
    this.editingColorIndex = null;
    this.destroyLibraryColorPicker();
    this.renderPatternCanvas();
  }

  private async mountLibraryColorPicker(index: number): Promise<void> {
    if (!this.isValidPaletteIndex(index) || this.editingColorIndex !== index) {
      return;
    }

    const host = this.findPickerHost(index);
    if (!host) {
      return;
    }

    const { default: Pickr } = await import('@simonwep/pickr');
    if (this.editingColorIndex !== index) {
      return;
    }

    if (this.pickerInstance && this.pickerIndex === index) {
      this.pickerInstance.setColor(this.colorDrafts[index] ?? this.palette[index].hex, true);
      this.pickerInstance.show();
      return;
    }

    this.destroyLibraryColorPicker();

    const picker = Pickr.create({
      el: host,
      useAsButton: true,
      container: document.body,
      position: 'bottom-middle',
      theme: 'nano',
      default: this.colorDrafts[index] ?? this.palette[index].hex,
      comparison: false,
      lockOpacity: true,
      components: {
        preview: true,
        opacity: false,
        hue: true,
        interaction: {
          hex: true,
          input: true,
          save: true,
          cancel: true
        }
      }
    });

    picker.on('change', (color: any) => {
      const hex = color?.toHEXA?.().toString().toUpperCase();
      if (!hex || this.editingColorIndex !== index) {
        return;
      }

      this.colorDrafts[index] = hex;
      this.applyHexColor(index);
    });

    picker.on('save', (color: any) => {
      const hex = color?.toHEXA?.().toString().toUpperCase();
      if (!hex || this.editingColorIndex !== index) {
        return;
      }

      this.colorDrafts[index] = hex;
      this.applyHexColor(index);
      picker.hide();
    });

    picker.on('cancel', () => {
      if (!this.isValidPaletteIndex(index)) {
        return;
      }

      this.colorDrafts[index] = this.palette[index].hex;
      picker.hide();
    });

    this.pickerInstance = picker;
    this.pickerIndex = index;
    picker.show();
  }

  private destroyLibraryColorPicker(): void {
    if (!this.pickerInstance) {
      return;
    }

    // Do not remove the trigger element from the DOM; only destroy picker instance.
    this.pickerInstance.destroy?.();
    this.pickerInstance = null;
    this.pickerIndex = null;
  }

  private findPickerHost(index: number): HTMLElement | null {
    const buttonRef = this.editButtons
      ?.toArray()
      .find((ref) => Number(ref.nativeElement.dataset['index']) === index);

    if (buttonRef?.nativeElement) {
      return buttonRef.nativeElement;
    }

    const hostRef = this.pickerHosts
      ?.toArray()
      .find((ref) => Number(ref.nativeElement.dataset['index']) === index);

    return hostRef?.nativeElement ?? null;
  }

  downloadPattern(): void {
    const canvas = this.patternCanvas?.nativeElement;
    if (!canvas || this.grid.length === 0) {
      return;
    }

    const link = document.createElement('a');
    const safeBaseName = (this.imageName || 'patron')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    const stamp = `${this.patternWidth}x${this.patternHeight}_${this.palette.length}colores`;

    link.href = canvas.toDataURL('image/png');
    link.download = `${safeBaseName || 'patron'}_${stamp}.png`;
    link.click();
  }

  downloadPatternWithPalette(): void {
    const patternCanvas = this.patternCanvas?.nativeElement;
    if (!patternCanvas || this.grid.length === 0 || this.palette.length === 0) {
      return;
    }

    const rowHeight = 34;
    const headerHeight = 74;
    const footerHeight = 20;
    const panelWidth = 360;
    const gap = 18;
    const padding = 20;
    const paletteHeight = headerHeight + this.palette.length * rowHeight + footerHeight;
    const width = patternCanvas.width + panelWidth + gap + padding * 2;
    const height = Math.max(patternCanvas.height + padding * 2, paletteHeight + padding * 2);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return;
    }

    ctx.fillStyle = '#fffdf8';
    ctx.fillRect(0, 0, width, height);

    const patternX = padding;
    const patternY = padding;
    const panelX = patternX + patternCanvas.width + gap;
    const panelY = padding;

    ctx.drawImage(patternCanvas, patternX, patternY);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(panelX, panelY, panelWidth, height - padding * 2);
    ctx.strokeStyle = '#d9c4a8';
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX + 0.5, panelY + 0.5, panelWidth - 1, height - padding * 2 - 1);

    ctx.fillStyle = '#3d3025';
    ctx.font = '700 25px "Trebuchet MS", sans-serif';
    ctx.fillText('Paleta de Hilos', panelX + 18, panelY + 36);

    ctx.font = '14px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#6a5848';
    ctx.fillText(
      `Colores: ${this.palette.length} | Cuadricula: ${this.patternWidth} x ${this.patternHeight}`,
      panelX + 18,
      panelY + 58
    );

    for (let i = 0; i < this.palette.length; i += 1) {
      const color = this.palette[i];
      const yTop = panelY + headerHeight + i * rowHeight;
      const yMid = yTop + rowHeight / 2;

      ctx.fillStyle = i % 2 === 0 ? '#fff6ea' : '#fffdf8';
      ctx.fillRect(panelX + 12, yTop + 2, panelWidth - 24, rowHeight - 4);

      ctx.fillStyle = color.hex;
      ctx.fillRect(panelX + 22, yTop + 7, 22, 20);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.strokeRect(panelX + 22, yTop + 7, 22, 20);

      ctx.fillStyle = '#2d241d';
      ctx.font = '700 13px "Courier New", monospace';
      ctx.fillText(String(i + 1).padStart(2, '0'), panelX + 54, yMid + 5);
      ctx.fillText(color.symbol, panelX + 88, yMid + 5);

      ctx.font = '700 12px "Courier New", monospace';
      ctx.fillText(color.hex, panelX + 116, yMid + 5);

      ctx.font = '12px "Trebuchet MS", sans-serif';
      ctx.fillText(`${color.count} celdas`, panelX + 230, yMid + 5);
    }

    const safeBaseName = (this.imageName || 'patron')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();

    const stamp = `${this.patternWidth}x${this.patternHeight}_${this.palette.length}colores`;
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `${safeBaseName || 'patron'}_${stamp}_con-paleta.png`;
    link.click();
  }

  totalStitches(): number {
    return this.stitchCount;
  }

  private quantize(raw: Uint8ClampedArray, width: number, height: number, k: number): PatternBuildResult {
    const totalPixels = width * height;
    const pixels: Rgb[] = [];
    const sourceIndexes: number[] = [];

    for (let i = 0; i < totalPixels; i += 1) {
      const base = i * 4;
      const alphaByte = raw[base + 3];
      if (alphaByte < 20) {
        continue;
      }

      const alpha = alphaByte / 255;
      const r = Math.round(raw[base] * alpha + 255 * (1 - alpha));
      const g = Math.round(raw[base + 1] * alpha + 255 * (1 - alpha));
      const b = Math.round(raw[base + 2] * alpha + 255 * (1 - alpha));
      pixels.push({ r, g, b });
      sourceIndexes.push(i);
    }

    if (pixels.length === 0) {
      return {
        grid: Array.from({ length: height }, () => Array.from({ length: width }, () => -1)),
        palette: []
      };
    }

    const clusterCount = Math.min(k, Math.max(1, pixels.length));
    const centroids: Rgb[] = [];

    for (let i = 0; i < clusterCount; i += 1) {
      const sampleIndex = Math.min(pixels.length - 1, Math.floor((i * pixels.length) / clusterCount));
      centroids.push({ ...pixels[sampleIndex] });
    }

    const assignments = new Int16Array(pixels.length);

    for (let iteration = 0; iteration < 8; iteration += 1) {
      const sumR = new Array<number>(clusterCount).fill(0);
      const sumG = new Array<number>(clusterCount).fill(0);
      const sumB = new Array<number>(clusterCount).fill(0);
      const counts = new Array<number>(clusterCount).fill(0);

      for (let i = 0; i < pixels.length; i += 1) {
        const nearest = this.findNearestCentroid(pixels[i], centroids);
        assignments[i] = nearest;
        sumR[nearest] += pixels[i].r;
        sumG[nearest] += pixels[i].g;
        sumB[nearest] += pixels[i].b;
        counts[nearest] += 1;
      }

      for (let c = 0; c < clusterCount; c += 1) {
        if (counts[c] === 0) {
          const fallback = pixels[Math.min(pixels.length - 1, Math.floor(((c + 1) * pixels.length) / (clusterCount + 1)))];
          centroids[c] = { ...fallback };
          continue;
        }

        centroids[c] = {
          r: Math.round(sumR[c] / counts[c]),
          g: Math.round(sumG[c] / counts[c]),
          b: Math.round(sumB[c] / counts[c])
        };
      }
    }

    const clusterUsage = new Array<number>(clusterCount).fill(0);
    for (let i = 0; i < pixels.length; i += 1) {
      clusterUsage[assignments[i]] += 1;
    }

    const activeClusters: Array<{ clusterId: number; color: Rgb; count: number }> = [];
    for (let i = 0; i < clusterCount; i += 1) {
      if (clusterUsage[i] > 0) {
        activeClusters.push({
          clusterId: i,
          color: centroids[i],
          count: clusterUsage[i]
        });
      }
    }

    activeClusters.sort((a, b) => b.count - a.count);
    const remap = new Map<number, number>();

    const palette: PaletteEntry[] = activeClusters.map((entry, idx) => {
      remap.set(entry.clusterId, idx);
      return {
        ...entry.color,
        hex: this.toHex(entry.color),
        count: entry.count,
        symbol: this.symbols[idx % this.symbols.length]
      };
    });

    const pixelToPalette = new Int16Array(totalPixels).fill(-1);
    for (let i = 0; i < sourceIndexes.length; i += 1) {
      pixelToPalette[sourceIndexes[i]] = remap.get(assignments[i]) ?? 0;
    }

    const grid: number[][] = [];
    for (let y = 0; y < height; y += 1) {
      const row: number[] = [];
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        row.push(pixelToPalette[index]);
      }
      grid.push(row);
    }

    return { grid, palette };
  }

  private buildExactPalette(
    raw: Uint8ClampedArray,
    width: number,
    height: number,
    maxUniqueColors: number
  ): PatternBuildResult {
    const totalPixels = width * height;
    const colorToIndex = new Map<string, number>();
    const palette: PaletteEntry[] = [];
    const grid: number[][] = Array.from({ length: height }, () => Array<number>(width).fill(-1));

    for (let i = 0; i < totalPixels; i += 1) {
      const base = i * 4;
      const alphaByte = raw[base + 3];
      if (alphaByte < 20) {
        continue;
      }

      const alpha = alphaByte / 255;
      const r = Math.round(raw[base] * alpha + 255 * (1 - alpha));
      const g = Math.round(raw[base + 1] * alpha + 255 * (1 - alpha));
      const b = Math.round(raw[base + 2] * alpha + 255 * (1 - alpha));
      const hex = this.toHex({ r, g, b });

      let paletteIndex = colorToIndex.get(hex);
      if (paletteIndex === undefined) {
        if (palette.length >= maxUniqueColors) {
          return {
            grid: [],
            palette: [],
            error: `No se puede generar sin extrapolar: se detectaron mas de ${maxUniqueColors} colores unicos.`
          };
        }

        paletteIndex = palette.length;
        colorToIndex.set(hex, paletteIndex);
        palette.push({
          r,
          g,
          b,
          hex,
          count: 0,
          symbol: this.symbols[paletteIndex % this.symbols.length]
        });
      }

      const y = Math.floor(i / width);
      const x = i % width;
      grid[y][x] = paletteIndex;
      palette[paletteIndex].count += 1;
    }

    return { grid, palette };
  }

  private renderPatternCanvas(): void {
    const canvas = this.patternCanvas?.nativeElement;
    if (!canvas || this.grid.length === 0) {
      return;
    }

    const rows = this.grid.length;
    const cols = this.grid[0].length;
    const cell = this.clamp(Math.round(this.stitchSize), 6, 32);
    const showGuide = this.showGuideGrid;
    const axisPad = showGuide ? Math.max(22, Math.floor(cell * 1.7)) : 0;
    const originX = axisPad;
    const originY = axisPad;
    const patternW = cols * cell;
    const patternH = rows * cell;
    canvas.width = patternW + originX;
    canvas.height = patternH + originY;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (this.activeTextureBackground) {
      const pattern = ctx.createPattern(this.activeTextureBackground, 'repeat');
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(originX, originY, patternW, patternH);
      }
    }

    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const colorIndex = this.grid[y][x];
        if (!this.isValidPaletteIndex(colorIndex)) {
          continue;
        }

        const color = this.palette[colorIndex];
        ctx.fillStyle = color.hex;
        ctx.fillRect(originX + x * cell, originY + y * cell, cell, cell);

        if (this.showSymbols && cell >= 11) {
          ctx.fillStyle = this.contrastTextColor(color);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = `${Math.max(8, Math.floor(cell * 0.5))}px "Courier New", monospace`;
          ctx.fillText(color.symbol, originX + x * cell + cell / 2, originY + y * cell + cell / 2 + 0.5);
        }
      }
    }

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.lineWidth = 1;

    if (cell >= 10) {
      for (let y = 0; y <= rows; y += 1) {
        const yy = originY + y * cell + 0.5;
        ctx.beginPath();
        ctx.moveTo(originX, yy);
        ctx.lineTo(originX + patternW, yy);
        ctx.stroke();
      }

      for (let x = 0; x <= cols; x += 1) {
        const xx = originX + x * cell + 0.5;
        ctx.beginPath();
        ctx.moveTo(xx, originY);
        ctx.lineTo(xx, originY + patternH);
        ctx.stroke();
      }
    }

    if (showGuide) {
      const step = this.clamp(Math.round(this.guideDensity), 2, 80);
      const colSegments = this.buildGuideSegments(cols, step);
      const rowSegments = this.buildGuideSegments(rows, step);

      ctx.strokeStyle = 'rgba(120, 55, 25, 0.75)';
      ctx.lineWidth = Math.max(1.4, cell * 0.14);
      ctx.fillStyle = '#623f2a';
      ctx.font = `${Math.max(10, Math.floor(cell * 0.7))}px "Trebuchet MS", sans-serif`;

      for (let i = 0; i < colSegments.length; i += 1) {
        const segment = colSegments[i];
        const xx = originX + segment.start * cell + 0.5;
        ctx.beginPath();
        ctx.moveTo(xx, originY);
        ctx.lineTo(xx, originY + patternH);
        ctx.stroke();

        const label = this.formatGuideLabel(i + 1, this.colGuideLabelMode);
        const centerCell = segment.start + segment.length / 2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, originX + centerCell * cell, Math.floor(originY / 2));
      }

      const finalGuideX = originX + cols * cell + 0.5;
      ctx.beginPath();
      ctx.moveTo(finalGuideX, originY);
      ctx.lineTo(finalGuideX, originY + patternH);
      ctx.stroke();

      for (let i = 0; i < rowSegments.length; i += 1) {
        const segment = rowSegments[i];
        const yy = originY + segment.start * cell + 0.5;
        ctx.beginPath();
        ctx.moveTo(originX, yy);
        ctx.lineTo(originX + patternW, yy);
        ctx.stroke();

        const label = this.formatGuideLabel(i + 1, this.rowGuideLabelMode);
        const centerCell = segment.start + segment.length / 2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, Math.floor(originX / 2), originY + centerCell * cell);
      }

      const finalGuideY = originY + rows * cell + 0.5;
      ctx.beginPath();
      ctx.moveTo(originX, finalGuideY);
      ctx.lineTo(originX + patternW, finalGuideY);
      ctx.stroke();
    }
  }

  private remapGridColor(sourceIndex: number, targetIndex: number): void {
    for (let y = 0; y < this.grid.length; y += 1) {
      for (let x = 0; x < this.grid[y].length; x += 1) {
        if (this.grid[y][x] === sourceIndex) {
          this.grid[y][x] = targetIndex;
        }
      }
    }
  }

  private rebuildPaletteFromGrid(): void {
    if (this.palette.length === 0 || this.grid.length === 0) {
      return;
    }

    const counts = new Array<number>(this.palette.length).fill(0);
    for (let y = 0; y < this.grid.length; y += 1) {
      for (let x = 0; x < this.grid[y].length; x += 1) {
        const colorIndex = this.grid[y][x];
        if (this.isValidPaletteIndex(colorIndex)) {
          counts[colorIndex] += 1;
        }
      }
    }

    const remap = new Map<number, number>();
    const nextPalette: PaletteEntry[] = [];
    for (let oldIndex = 0; oldIndex < this.palette.length; oldIndex += 1) {
      if (counts[oldIndex] > 0) {
        const newIndex = nextPalette.length;
        remap.set(oldIndex, newIndex);
        nextPalette.push({
          ...this.palette[oldIndex],
          count: counts[oldIndex],
          symbol: this.symbols[newIndex % this.symbols.length]
        });
      }
    }

    for (let y = 0; y < this.grid.length; y += 1) {
      for (let x = 0; x < this.grid[y].length; x += 1) {
        const current = this.grid[y][x];
        this.grid[y][x] = current < 0 ? -1 : (remap.get(current) ?? -1);
      }
    }

    this.palette = nextPalette;
    this.stitchCount = this.countStitchesInGrid();
    if (this.editingColorIndex !== null && this.editingColorIndex >= this.palette.length) {
      this.editingColorIndex = null;
    }

    this.syncColorDrafts();
  }

  private syncColorDrafts(): void {
    this.colorDrafts = this.palette.map((entry) => entry.hex);
  }

  private isValidPaletteIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.palette.length;
  }

  private findNearestPaletteIndex(sourceIndex: number): number {
    const source = this.palette[sourceIndex];
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < this.palette.length; index += 1) {
      if (index === sourceIndex) {
        continue;
      }

      const target = this.palette[index];
      const dr = source.r - target.r;
      const dg = source.g - target.g;
      const db = source.b - target.b;
      const distance = dr * dr + dg * dg + db * db;

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  private hexToRgb(hex: string): Rgb | null {
    const normalized = hex.replace('#', '');
    if (normalized.length !== 6) {
      return null;
    }

    const raw = Number.parseInt(normalized, 16);
    if (Number.isNaN(raw)) {
      return null;
    }

    return {
      r: (raw >> 16) & 255,
      g: (raw >> 8) & 255,
      b: raw & 255
    };
  }

  private findNearestCentroid(pixel: Rgb, centroids: Rgb[]): number {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < centroids.length; i += 1) {
      const c = centroids[i];
      const dr = pixel.r - c.r;
      const dg = pixel.g - c.g;
      const db = pixel.b - c.b;
      const dist = dr * dr + dg * dg + db * db;

      if (dist < bestDistance) {
        bestDistance = dist;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  private contrastTextColor(color: Rgb): string {
    const luminance = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
    return luminance > 0.58 ? '#111111' : '#f7f7f7';
  }

  private toHex(color: Rgb): string {
    return `#${this.toHexPair(color.r)}${this.toHexPair(color.g)}${this.toHexPair(color.b)}`;
  }

  private toHexPair(value: number): string {
    return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0').toUpperCase();
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private openCropModal(fileName: string, image: HTMLImageElement): void {
    this.pendingImageName = fileName;
    this.pendingSourceImage = image;
    this.isCropModalOpen = true;
    this.cropDragActive = false;
    this.activeCropEdge = null;
    this.hasLightBackground = this.detectLikelyLightBackground(image);
    this.useTextureBackground = false;
    this.texturePreview = '';
    this.textureImage = null;

    requestAnimationFrame(() => {
      this.prepareCropCanvas();
    });
  }

  private prepareCropCanvas(): void {
    const canvas = this.cropCanvas?.nativeElement;
    const source = this.pendingSourceImage;

    if (!canvas || !source) {
      return;
    }

    const width = 920;
    const height = 560;
    canvas.width = width;
    canvas.height = height;

    const padding = 20;
    const availableW = width - padding * 2;
    const availableH = height - padding * 2;
    const scale = Math.min(availableW / source.width, availableH / source.height);
    const drawW = Math.round(source.width * scale);
    const drawH = Math.round(source.height * scale);
    const drawX = Math.round((width - drawW) / 2);
    const drawY = Math.round((height - drawH) / 2);

    this.cropImageBounds = { x: drawX, y: drawY, width: drawW, height: drawH, scale };
    this.resetCropInsets();
    this.renderCropCanvas();
  }

  private resetCropInsets(): void {
    this.cropInsets = { left: 0, right: 0, top: 0, bottom: 0 };
    this.syncCropSelectionFromInsets();
    this.renderCropCanvas();
  }

  private enforceCropInsetLimits(preferredSide?: 'left' | 'right' | 'top' | 'bottom'): void {
    const maxPair = 95;

    this.cropInsets.left = this.clamp(Math.round(this.cropInsets.left), 0, 95);
    this.cropInsets.right = this.clamp(Math.round(this.cropInsets.right), 0, 95);
    this.cropInsets.top = this.clamp(Math.round(this.cropInsets.top), 0, 95);
    this.cropInsets.bottom = this.clamp(Math.round(this.cropInsets.bottom), 0, 95);

    if (this.cropInsets.left + this.cropInsets.right > maxPair) {
      if (preferredSide === 'left') {
        this.cropInsets.right = maxPair - this.cropInsets.left;
      } else {
        this.cropInsets.left = maxPair - this.cropInsets.right;
      }
    }

    if (this.cropInsets.top + this.cropInsets.bottom > maxPair) {
      if (preferredSide === 'top') {
        this.cropInsets.bottom = maxPair - this.cropInsets.top;
      } else {
        this.cropInsets.top = maxPair - this.cropInsets.bottom;
      }
    }
  }

  private syncCropSelectionFromInsets(): void {
    const bounds = this.cropImageBounds;
    const leftPx = (bounds.width * this.cropInsets.left) / 100;
    const rightPx = (bounds.width * this.cropInsets.right) / 100;
    const topPx = (bounds.height * this.cropInsets.top) / 100;
    const bottomPx = (bounds.height * this.cropInsets.bottom) / 100;

    this.cropSelection = {
      x: bounds.x + leftPx,
      y: bounds.y + topPx,
      width: Math.max(2, bounds.width - leftPx - rightPx),
      height: Math.max(2, bounds.height - topPx - bottomPx)
    };
  }

  private renderCropCanvas(): void {
    const canvas = this.cropCanvas?.nativeElement;
    const source = this.pendingSourceImage;

    if (!canvas || !source) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const image = this.cropImageBounds;
    this.syncCropSelectionFromInsets();
    const crop = this.cropSelection;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#20160f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (this.useTextureBackground && this.textureImage && this.hasLightBackground) {
      const pattern = ctx.createPattern(this.textureImage, 'repeat');
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(image.x, image.y, image.width, image.height);
      }
    }

    ctx.drawImage(source, image.x, image.y, image.width, image.height);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
    ctx.fillRect(image.x, image.y, image.width, image.height);

    ctx.drawImage(
      source,
      (crop.x - image.x) / image.scale,
      (crop.y - image.y) / image.scale,
      crop.width / image.scale,
      crop.height / image.scale,
      crop.x,
      crop.y,
      crop.width,
      crop.height
    );

    ctx.strokeStyle = '#f7d18f';
    ctx.lineWidth = 2;
    ctx.strokeRect(crop.x + 0.5, crop.y + 0.5, crop.width - 1, crop.height - 1);

    ctx.fillStyle = '#f7d18f';
    ctx.fillRect(crop.x - 4, crop.y + crop.height / 2 - 18, 8, 36);
    ctx.fillRect(crop.x + crop.width - 4, crop.y + crop.height / 2 - 18, 8, 36);
    ctx.fillRect(crop.x + crop.width / 2 - 18, crop.y - 4, 36, 8);
    ctx.fillRect(crop.x + crop.width / 2 - 18, crop.y + crop.height - 4, 36, 8);

    ctx.fillStyle = '#f7d18f';
    ctx.font = '600 14px "Trebuchet MS", sans-serif';
    ctx.fillText('Arrastra los bordes del recorte sobre la imagen', 24, 26);
  }

  private detectClosestCropEdge(x: number, y: number): 'left' | 'right' | 'top' | 'bottom' | null {
    const crop = this.cropSelection;
    const threshold = 14;
    const inVerticalSpan = y >= crop.y - threshold && y <= crop.y + crop.height + threshold;
    const inHorizontalSpan = x >= crop.x - threshold && x <= crop.x + crop.width + threshold;

    const distances: Array<{ side: 'left' | 'right' | 'top' | 'bottom'; d: number }> = [];

    if (inVerticalSpan) {
      distances.push({ side: 'left', d: Math.abs(x - crop.x) });
      distances.push({ side: 'right', d: Math.abs(x - (crop.x + crop.width)) });
    }

    if (inHorizontalSpan) {
      distances.push({ side: 'top', d: Math.abs(y - crop.y) });
      distances.push({ side: 'bottom', d: Math.abs(y - (crop.y + crop.height)) });
    }

    const near = distances.filter((item) => item.d <= threshold).sort((a, b) => a.d - b.d)[0];
    return near?.side ?? null;
  }

  private updateCropByEdgePoint(side: 'left' | 'right' | 'top' | 'bottom', x: number, y: number): void {
    const bounds = this.cropImageBounds;

    if (side === 'left') {
      const clampedX = this.clamp(x, bounds.x, bounds.x + bounds.width);
      this.cropInsets.left = ((clampedX - bounds.x) / bounds.width) * 100;
    }

    if (side === 'right') {
      const clampedX = this.clamp(x, bounds.x, bounds.x + bounds.width);
      this.cropInsets.right = ((bounds.x + bounds.width - clampedX) / bounds.width) * 100;
    }

    if (side === 'top') {
      const clampedY = this.clamp(y, bounds.y, bounds.y + bounds.height);
      this.cropInsets.top = ((clampedY - bounds.y) / bounds.height) * 100;
    }

    if (side === 'bottom') {
      const clampedY = this.clamp(y, bounds.y, bounds.y + bounds.height);
      this.cropInsets.bottom = ((bounds.y + bounds.height - clampedY) / bounds.height) * 100;
    }

    this.enforceCropInsetLimits(side);
    this.renderCropCanvas();
  }

  private updateCropCanvasCursor(edge: 'left' | 'right' | 'top' | 'bottom' | null): void {
    const canvas = this.cropCanvas?.nativeElement;
    if (!canvas) {
      return;
    }

    if (edge === 'left' || edge === 'right') {
      canvas.style.cursor = 'ew-resize';
      return;
    }

    if (edge === 'top' || edge === 'bottom') {
      canvas.style.cursor = 'ns-resize';
      return;
    }

    canvas.style.cursor = 'default';
  }

  private getCropCanvasPoint(event: PointerEvent): { x: number; y: number } | null {
    const canvas = this.cropCanvas?.nativeElement;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY
    };
  }

  private samplePatchColor(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    startX: number,
    startY: number,
    size: number
  ): Rgb {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;

    const x0 = this.clamp(Math.round(startX), 0, width - 1);
    const y0 = this.clamp(Math.round(startY), 0, height - 1);
    const x1 = this.clamp(x0 + size, 1, width);
    const y1 = this.clamp(y0 + size, 1, height);

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const idx = (y * width + x) * 4;
        sumR += data[idx];
        sumG += data[idx + 1];
        sumB += data[idx + 2];
        count += 1;
      }
    }

    if (count === 0) {
      return { r: 255, g: 255, b: 255 };
    }

    return {
      r: Math.round(sumR / count),
      g: Math.round(sumG / count),
      b: Math.round(sumB / count)
    };
  }

  private readCookie(name: string): string | null {
    const full = `; ${document.cookie}`;
    const parts = full.split(`; ${name}=`);
    if (parts.length < 2) {
      return null;
    }

    return parts.pop()?.split(';').shift() ?? null;
  }

  private writeCookie(name: string, value: string, days: number): void {
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
  }

  private finalizeCroppedImage(
    processingDataUrl: string,
    previewDataUrl: string,
    textureBackground: HTMLImageElement | null,
    shouldGenerate: boolean,
    processingCanvas: HTMLCanvasElement
  ): void {
    this.sourcePreview = previewDataUrl;
    this.activeTextureBackground = textureBackground;
    this.imageName = this.pendingImageName;
    this.isCropModalOpen = false;
    this.pendingSourceImage = null;
    this.pendingImageName = '';

    if (shouldGenerate) {
      this.generatePatternFromSource(processingCanvas);
    }

    const croppedImage = new Image();
    let sourceAssigned = false;
    const assignSourceImage = () => {
      if (sourceAssigned) {
        return;
      }
      sourceAssigned = true;
      this.sourceImage = croppedImage;
    };

    croppedImage.onload = assignSourceImage;
    croppedImage.src = processingDataUrl;

    // Fallback for browsers with inconsistent onload behavior for data URLs.
    if (croppedImage.complete && croppedImage.naturalWidth > 0) {
      assignSourceImage();
    }
  }

  private detectLikelyLightBackground(image: HTMLImageElement): boolean {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(16, Math.min(300, image.width));
    canvas.height = Math.max(16, Math.min(300, image.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return false;
    }

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let borderCount = 0;
    let lightCount = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const isBorder = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
        if (!isBorder) {
          continue;
        }

        borderCount += 1;
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const bright = (r + g + b) / 3;

        if (bright >= 215 && maxC - minC <= 42) {
          lightCount += 1;
        }
      }
    }

    return borderCount > 0 && lightCount / borderCount >= 0.7;
  }

  private buildConnectedLightMask(imageData: ImageData): Uint8Array {
    const { data, width, height } = imageData;
    const candidate = new Uint8Array(width * height);
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);

    for (let i = 0; i < width * height; i += 1) {
      const idx = i * 4;
      const alpha = data[idx + 3];
      if (alpha < 20) {
        candidate[i] = 1;
        continue;
      }

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const bright = (r + g + b) / 3;
      candidate[i] = bright >= 210 && maxC - minC <= 45 ? 1 : 0;
    }

    let qh = 0;
    let qt = 0;
    const pushIfCandidate = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= width || y >= height) {
        return;
      }

      const pos = y * width + x;
      if (candidate[pos] !== 1 || visited[pos] === 1) {
        return;
      }

      visited[pos] = 1;
      queue[qt] = pos;
      qt += 1;
    };

    for (let x = 0; x < width; x += 1) {
      pushIfCandidate(x, 0);
      pushIfCandidate(x, height - 1);
    }

    for (let y = 0; y < height; y += 1) {
      pushIfCandidate(0, y);
      pushIfCandidate(width - 1, y);
    }

    while (qh < qt) {
      const pos = queue[qh];
      qh += 1;
      const x = pos % width;
      const y = Math.floor(pos / width);

      pushIfCandidate(x - 1, y);
      pushIfCandidate(x + 1, y);
      pushIfCandidate(x, y - 1);
      pushIfCandidate(x, y + 1);
    }

    return visited;
  }

  private countStitchesInGrid(): number {
    let count = 0;
    for (let y = 0; y < this.grid.length; y += 1) {
      for (let x = 0; x < this.grid[y].length; x += 1) {
        if (this.grid[y][x] >= 0) {
          count += 1;
        }
      }
    }

    return count;
  }

  private formatGuideLabel(index: number, mode: 'numbers' | 'letters'): string {
    if (mode === 'numbers') {
      return String(index);
    }

    return this.toAlphabeticLabel(index);
  }

  private buildGuideSegments(totalCells: number, targetStep: number): Array<{ start: number; length: number }> {
    if (totalCells <= 0) {
      return [];
    }

    const requestedStep = this.clamp(Math.round(targetStep), 1, totalCells);
    const segmentCount = this.clamp(Math.round(totalCells / requestedStep), 1, totalCells);
    const baseLength = Math.floor(totalCells / segmentCount);
    const remainder = totalCells % segmentCount;

    const segments: Array<{ start: number; length: number }> = [];
    let cursor = 0;

    for (let i = 0; i < segmentCount; i += 1) {
      const length = baseLength + (i < remainder ? 1 : 0);
      segments.push({ start: cursor, length });
      cursor += length;
    }

    return segments;
  }

  private toAlphabeticLabel(index: number): string {
    let value = Math.max(1, Math.floor(index));
    let label = '';

    while (value > 0) {
      const remainder = (value - 1) % 26;
      label = String.fromCharCode(65 + remainder) + label;
      value = Math.floor((value - 1) / 26);
    }

    return label;
  }
}
