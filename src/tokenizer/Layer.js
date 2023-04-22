import Utils from '../libs/Utils.js';
import { geom } from '../libs/MarchingSquares.js';
import CONSTANTS from '../constants.js';
import { generateRayMask } from '../libs/RayMask.js';
import { Masker } from './Masker.js';
import Color from '../libs/Color.js';
import logger from '../libs/logger.js';

export default class Layer {
  constructor({ view, canvas, tintColor, tintLayer, img = null, color = null } = {}) {
    this.view = view;
    this.id = Utils.generateUUID();
    this.canvas = canvas;
    // keep a copy of the source to work transforms from
    this.source = Utils.cloneCanvas(this.canvas);
    // canvas referencing to the source (image) that will be displayed on the view canvas
    this.preview = Utils.cloneCanvas(this.canvas);

    // the current position of the source image on the view canvas
    this.position = {
      x: 0,
      y: 0,
    };

    // the current scale, will be calculated once an image is loaded into the view canvas
    this.scale = 1;

    // the current degree of rotation
    this.rotation = 0;

    // mirror
    this.center = { x: this.canvas.width / 2, y: this.canvas.height / 2 };
    this.mirror = 1;
    this.flipped = false;

    // the image drawn on the source, kept for rotations
    if (img) {
      this.img = img;
      this.sourceImg = img.src;
    }

    // active layers allow mouse events to be followed (scale/translate)
    this.active = false;

    // source mask is the mask generated by the source image, and mask can be another mask
    // from another layer
    this.providesMask = false;
    this.renderedMask = document.createElement('canvas');
    this.renderedMask.width = this.source.width;
    this.renderedMask.height = this.source.height;
    this.mask = null;
    this.maskCompositeOperation = CONSTANTS.BLEND_MODES.SOURCE_IN;
    this.customMask = false;

    // mask ids to apply to this layer
    this.appliedMaskIds = new Set();
    this.customMaskLayers = false;

    this.alpha = 1.0;
    this.compositeOperation = CONSTANTS.BLEND_MODES.SOURCE_OVER;
    this.visible = true;

    // initialize with color
    this.previousColor = null;
    this.color = color;
    this.colorLayer = color !== null;

    // extra alpha pixels
    this.previousAlphaPixelColors = null;
    this.alphaPixelColors = new Set();

    // tint the layer?
    this.tintLayer = tintLayer;
    this.tintColor = tintColor;
    // this.tintColor = "#f59042";
  }

  clone() {
    const imgOptions = {
      view: this.view,
      img: this.img,
      canvasHeight: this.source.height,
      canvasWidth: this.source.width,
      tintColor: this.tintColor,
      tintLayer: this.tintLayer,
    };

    const colorOptions = {
      view: this.view,
      color: this.color,
      canvasHeight: this.source.height,
      canvasWidth: this.source.width,
    };

    const newLayer = this.img
      ? Layer.fromImage(imgOptions)
      : Layer.fromColor(colorOptions);

    newLayer.active = false;

    newLayer.scale = this.scale;
    newLayer.rotation = this.rotation;
    newLayer.position = deepClone(this.position);
    newLayer.center = this.center;
    newLayer.mirror = this.mirror;
    newLayer.flipped = this.flipped;
    newLayer.visible = this.visible;
    newLayer.alpha = this.alpha;

    if (this.mask) newLayer.mask = Utils.cloneCanvas(this.mask);
    if (this.sourceMask) this.sourceMask = Utils.cloneCanvas(this.sourceMask);
    if (this.renderedMask) this.renderedMask = Utils.cloneCanvas(this.renderedMask);
    newLayer.customMask = this.customMask;
    newLayer.customMaskLayers = this.customMaskLayers;
    newLayer.appliedMaskIds = new Set(this.appliedMaskIds);

    newLayer.compositeOperation = this.compositeOperation;
    newLayer.maskCompositeOperation = this.maskCompositeOperation;


    newLayer.alphaPixelColors = new Set(this.alphaPixelColors);
    if (this.previousAlphaPixelColors) newLayer.previousAlphaPixelColors = new Set(this.previousAlphaPixelColors);

    return newLayer;
  }

  static isTransparent(pixels, x, y) {
    return CONSTANTS.TRANSPARENCY_THRESHOLD < pixels.data[(((y * pixels.width) + x) * 4) + 3];
  }

  getLayerLabel(active = false) {
    const index = this.view.layers.findIndex((layer) => layer.id === this.id);

    if (index === -1) return "?";
    if (active) {
      return CONSTANTS.NUMBERS.ACTIVE[index];
    } else {
      return CONSTANTS.NUMBERS.INACTIVE[index];
    }
  }

  applyCustomMask(mask, callback) {
    this.customMask = true;
    this.mask = mask;
    this.renderedMask
      .getContext('2d')
      .drawImage(this.mask, 0, 0, this.canvas.width, this.canvas.height);
    callback(true);
  }

  editMask(callback) {
    const maskEditor = new Masker(this);
    maskEditor.display(this.applyCustomMask.bind(this), callback).then(() => {
      maskEditor.draw();
    });
  }

  /**
   * Activates the event listeners on the view canvas for scaling and translating
   */
  activate() {
    this.active = true;
  }

  /**
   * Deactivates the event listeners on the view canvas for scaling and translating (color picking is always active)
   */
  deactivate() {
    this.active = false;
  }

  isCompletelyTransparent() {
    const pixels = this.source.getContext('2d').getImageData(0, 0, this.source.width, this.source.height).data;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > CONSTANTS.TRANSPARENCY_THRESHOLD) {
        return false;
      }
    }

    return true;
  }

  isCompletelyOpaque() {
    const pixels = this.source.getContext('2d').getImageData(0, 0, this.source.width, this.source.height).data;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < CONSTANTS.TRANSPARENCY_THRESHOLD) {
        return false;
      }
    }
    return true;
  }

  /**
   * Creates a mask using the marching squares algorithm by walking the edges of the non-transparent pixels to find a contour.
   * Works naturally best for token images which have a circular ring-shape. The algorithm walks the contour and fills the inner regions with black, too
   * The mask is not active on creating, it is controlled by
   *
   * this.applyMask(mask | null), see above
   */
  createOriginalMask() {
    // create intermediate canvas
    const temp = document.createElement('canvas');
    // create a canvas that has at least a 1px transparent border all around
    // so the marching squares algorithm won't run endlessly
    temp.width = CONSTANTS.MASK_DENSITY + 2;
    temp.height = CONSTANTS.MASK_DENSITY + 2;
    temp.getContext('2d').drawImage(this.canvas, 1, 1, this.canvas.width, this.canvas.height, 1, 1, CONSTANTS.MASK_DENSITY, CONSTANTS.MASK_DENSITY);

    // get the pixel data from the source image
    let context = temp.getContext('2d');
    const pixels = context.getImageData(0, 0, CONSTANTS.MASK_DENSITY + 2, CONSTANTS.MASK_DENSITY + 2);

    // re-use the intermediate canvas
    const defaultFillColor = game.settings.get(CONSTANTS.MODULE_ID, "default-color");
    if (defaultFillColor !== "") context.fillStyle = defaultFillColor;
    context.strokeStyle = '#000000AA';
    context.lineWidth = 1;
    context.fillStyle = "black";

    // the mask is totally transparent
    if (this.isCompletelyTransparent()) {
      context.clearRect(0, 0, temp.width, temp.height);
    } else if (this.isCompletelyOpaque()) {
      context.clearRect(0, 0, temp.width, temp.height);
      context.fillRect(0, 0, temp.width, temp.height);
      context.fill();
    } else {
      // process the pixel data
      const points = geom.contour((x, y) => Layer.isTransparent(pixels, x, y));
      context.clearRect(0, 0, temp.width, temp.height);
      context.beginPath();
      context.moveTo(points[0][0], points[0][4]);
      for (let i = 1; i < points.length; i++) {
        const point = points[i];
        context.lineTo(point[0], point[1]);
      }
      context.closePath();
      context.fill();
    }


    // clip the canvas
    this.renderedMask = document.createElement('canvas');
    this.renderedMask.width = this.source.width;
    this.renderedMask.height = this.source.height;
    this.renderedMask
      .getContext('2d')
      .drawImage(temp, 1, 1, CONSTANTS.MASK_DENSITY, CONSTANTS.MASK_DENSITY, 0, 0, this.source.width, this.source.height);
  }

  createMask() {
    if (!this.renderedMask) {
      this.renderedMask = document.createElement('canvas');
      this.renderedMask.width = this.source.width;
      this.renderedMask.height = this.source.height;
    }
    const rayMask = game.settings.get(CONSTANTS.MODULE_ID, "default-algorithm");
    if (rayMask) {
      this.mask = generateRayMask(this.canvas);
      const maskContext = this.renderedMask.getContext('2d');
      maskContext.resetTransform();
      maskContext.drawImage(this.mask, 0, 0, this.canvas.width, this.canvas.height);
    } else {
      this.createOriginalMask();
    }
    this.sourceMask = Utils.cloneCanvas(this.mask);
  }

  static fromImage({ view, img, canvasHeight, canvasWidth, tintColor, tintLayer } = {}) {
    const height = Math.max(1000, canvasHeight, img.naturalHeight, img.naturalWidth);
    const width = Math.max(1000, canvasWidth, img.naturalHeight, img.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const crop = game.settings.get(CONSTANTS.MODULE_ID, "default-crop-image");
    // if we crop the image we scale to the smallest dimension of the image
    // otherwise we scale to the largest dimension of the image
    const direction = crop ? img.naturalHeight > img.naturalWidth : img.naturalHeight < img.naturalWidth;

    const scaledWidth = !direction
      ? height * (img.width / img.height)
      : width;
    const scaledHeight = direction
      ? width * (img.height / img.width)
      : height;

    // offset the canvas for the scaled image
    const yOffset = (width - scaledWidth) / 2;
    const xOffset = (height - scaledHeight) / 2;

    const context = canvas.getContext("2d");
    context.drawImage(
        img,
        0,
        0,
        img.naturalWidth,
        img.naturalHeight,
        yOffset,
        xOffset,
        scaledWidth,
        scaledHeight
      );

    const layer = new Layer({ view, canvas, img, tintColor, tintLayer });
    layer.createMask();
    layer.redraw();
    return layer;
  }

  /**
   * Sets the background color for this layer. It will be masked, too
   * @param {color} hexColorString
   */
  setColor(hexColorString = null) {
    if (!this.colorLayer) return;
    this.color = hexColorString;
    const context = this.canvas.getContext("2d");
    context.fillStyle = hexColorString;
    context.rect(0, 0, this.width, this.height);
    context.fill();
    this.source = Utils.cloneCanvas(this.canvas);
  }

  static fromColor({ view, color, width, height } = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const layer = new Layer({ view, canvas, color });
    layer.setColor(color);
    return layer;
  }

  saveColor() {
    this.previousColor = this.color;
  }

  restoreColor() {
    this.setColor(this.previousColor);
  }

  saveAlphas() {
    this.previousAlphaPixelColors = new Set(this.alphaPixelColors);
  }

  restoreAlphas() {
    this.alphaPixelColors = new Set(this.previousAlphaPixelColors);
  }

  resetMasks() {
    this.customMaskLayers = false;
    this.appliedMaskIds.clear();
    this.view.layers.forEach((l) => {
      if (l.providesMask && this.view.isOriginLayerHigher(l.id, this.id)) {
        this.appliedMaskIds.add(l.id);
      }
    });
    this.compositeOperation = CONSTANTS.BLEND_MODES.SOURCE_OVER;
    this.maskCompositeOperation = CONSTANTS.BLEND_MODES.SOURCE_IN;
    this.customMask = false;
    this.mask = Utils.cloneCanvas(this.sourceMask);
    this.redraw();
  }

  reset() {
    this.customMaskLayers = false;
    this.appliedMaskIds.clear();
    this.alphaPixelColors.clear();
    this.view.layers.forEach((l) => {
      if (l.providesMask && this.view.isOriginLayerHigher(l.id, this.id)) {
        this.appliedMaskIds.add(l.id);
      }
    });
    this.compositeOperation = CONSTANTS.BLEND_MODES.SOURCE_OVER;
    this.maskCompositeOperation = CONSTANTS.BLEND_MODES.SOURCE_IN;
    this.scale = this.width / Math.max(this.source.width, this.source.height);
    this.rotation = 0;
    this.position.x = Math.floor((this.width / 2) - ((this.source.width * this.scale) / 2));
    this.position.y = Math.floor((this.height / 2) - ((this.source.height * this.scale) / 2));
    this.mask = null;
    this.customMask = false;
    this.redraw();
    this.createMask();
    this.recalculateMask();
  }

  /**
   * Gets the width of the view canvas
   */
  get width() {
    return this.canvas.width;
  }

  /**
   * Gets the height of the view canvas
   */
  get height() {
    return this.canvas.height;
  }

  /**
   * Translates the source on the view canvas
   * @param {Number} dx translation on the x-axis
   * @param {Number} dy translation on the y-axis
   */
  translate(dx, dy) {
    this.position.x -= dx;
    this.position.y -= dy;
    // this.redraw();
  }

  /**
   * Scales the source on the view canvas according to a given factor
   * @param {Number} factor
   */
  setScale(factor) {
    this.scale = factor;
  }

  rotate(degree) {
    this.rotation += degree * 2;
  }

  flip() {
    this.mirror *= -1;
    this.flipped = !this.flipped;
    this.redraw();
  }

  applyTransparentPixels(context) {
    if (this.alphaPixelColors.size === 0) return;

    let imageData = context.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.alphaPixelColors.forEach((color) => {
      // iterate over all pixels
      let count = 0;
      for (let i = 0, n = imageData.data.length; i < n; i += 4) {
        const pixelColor = new Color({
          red: imageData.data[i],
          blue: imageData.data[i + 1],
          green: imageData.data[i + 2],
          alpha: imageData.data[i + 3],
        });
        if (color.isNeighborColor(pixelColor)) {
          count++;
          imageData.data[i] = 0;
          imageData.data[i + 1] = 0;
          imageData.data[i + 2] = 0;
          imageData.data[i + 3] = 0;
        }
      }
      logger.debug("Applying the following color transparency", { color, count });
    });
    context.putImageData(imageData, 0, 0);
  }

  addTransparentColour(color) {
    this.alphaPixelColors.add(color);
  }

  applyTransformations(context, alpha = true) {
    context.resetTransform();
    context.clearRect(0, 0, this.source.width, this.source.height);
    context.translate(this.center.x, this.center.y);
    context.scale(this.mirror * 1, 1);
    context.rotate(this.rotation * CONSTANTS.TO_RADIANS);
    context.translate(-this.center.x, -this.center.y);
    if (alpha) context.globalAlpha = this.alpha;
  }

  recalculateMask() {
    if (this.mask && this.renderedMask && !this.customMask) {
      const context = this.renderedMask.getContext('2d');
      this.applyTransformations(context, false);
      context.drawImage(
        this.mask,
        this.position.x,
        this.position.y,
        this.source.width * this.scale,
        this.source.height * this.scale,
      );
    }
  }

  applyTint(context) {
    const tintCanvas = Utils.cloneCanvas(this.source);
    const tintContext = tintCanvas.getContext("2d");
    tintCanvas.width = this.source.width;
    tintCanvas.height = this.source.height;
    this.applyTransformations(tintContext, false);
    tintContext.drawImage(this.source, 0, 0);
    tintContext.globalCompositeOperation = 'source-atop';
    tintContext.fillStyle = this.tintColor;
    tintContext.fillRect(0, 0, this.source.width, this.source.height);  
    tintContext.globalCompositeOperation = 'source-over';

    context.globalCompositeOperation = 'color';
    context.drawImage(tintCanvas, 0, 0);
    context.globalCompositeOperation = 'source-over';
  }

  /**
   * Refreshes the view canvas with the background color and/or the source image
   */
  redraw() {
    // we take the original image and apply our scaling transformations
    const original = Utils.cloneCanvas(this.source);
    // apply transformations to original
    const originalContext = original.getContext("2d");
    this.applyTransformations(originalContext, this.source, false);
    originalContext.drawImage(this.source, 0, 0);
    if (this.tintLayer) this.applyTint(originalContext);
    originalContext.resetTransform();

    // place the computed layer on the view canvas

    const preview = this.preview.getContext("2d");
    const context = this.canvas.getContext("2d");
    [context, preview].forEach((cContext) => {
      cContext.globalCompositeOperation = this.compositeOperation;
      cContext.clearRect(0, 0, this.source.width, this.source.height);
      cContext.resetTransform();
    });

    const maskIds = this.customMaskLayers ? this.appliedMaskIds : this.view.maskIds;
    for (const maskId of maskIds) {
      const maskLayer = this.view.getMaskLayer(maskId);
      // we apply the mask if the layer is below a masking layer if not using custom masking layers
      if (maskLayer
        && (this.customMaskLayers || (!this.customMaskLayers && this.view.isOriginLayerHigher(maskId, this.id)))
      ) {
        context.drawImage(
          maskLayer.renderedMask,
          0,
          0,
          maskLayer.width,
          maskLayer.height,
          0,
          0,
          this.canvas.width,
          this.canvas.height
        );
        context.globalCompositeOperation = this.maskCompositeOperation;
      }
    }

    [context, preview].forEach((cContext) => {
      cContext.translate(0, 0);

      if (this.colorLayer) {
        cContext.fillStyle = this.color;
        cContext.rect(0, 0, this.width, this.height);
        cContext.fill();
      } else {
        // apply computed image and scale
        cContext.drawImage(
          original,
          this.position.x,
          this.position.y,
          this.source.width * this.scale,
          this.source.height * this.scale
        );
        this.applyTransparentPixels(cContext);
      }

      cContext.resetTransform();
    });
  }
}
