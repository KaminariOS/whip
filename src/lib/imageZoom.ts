export interface ImageZoomSize {
  width: number;
  height: number;
}

export const MIN_IMAGE_ZOOM = 1;
export const MAX_IMAGE_ZOOM = 5;
export const DOUBLE_TAP_IMAGE_ZOOM = 2.5;

export function clampImageZoom(value: number): number {
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, value));
}

export function containedImageSize(
  source: ImageZoomSize,
  viewport: ImageZoomSize,
): ImageZoomSize {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return {
      width: Math.max(0, viewport.width),
      height: Math.max(0, viewport.height),
    };
  }

  const fit = Math.min(
    viewport.width / source.width,
    viewport.height / source.height,
  );
  return { width: source.width * fit, height: source.height * fit };
}

export function clampImageTranslation(
  value: number,
  renderedSize: number,
  viewportSize: number,
  zoom: number,
): number {
  const limit = Math.max(0, (renderedSize * zoom - viewportSize) / 2);
  return Math.min(limit, Math.max(-limit, value));
}
