import {
  clampImageTranslation,
  clampImageZoom,
  containedImageSize,
  MAX_IMAGE_ZOOM,
  MIN_IMAGE_ZOOM,
} from '../src/lib/imageZoom';

describe('image preview zoom geometry', () => {
  it('fits an image inside the available viewport without changing its aspect ratio', () => {
    expect(
      containedImageSize(
        { width: 3000, height: 1500 },
        { width: 900, height: 1200 },
      ),
    ).toEqual({ width: 900, height: 450 });
    expect(
      containedImageSize(
        { width: 1000, height: 2000 },
        { width: 900, height: 1200 },
      ),
    ).toEqual({ width: 600, height: 1200 });
  });

  it('bounds zoom to the supported range', () => {
    expect(clampImageZoom(0.5)).toBe(MIN_IMAGE_ZOOM);
    expect(clampImageZoom(3)).toBe(3);
    expect(clampImageZoom(9)).toBe(MAX_IMAGE_ZOOM);
  });

  it('prevents panning beyond the scaled image edge', () => {
    expect(clampImageTranslation(500, 900, 1200, 2)).toBe(300);
    expect(clampImageTranslation(-500, 900, 1200, 2)).toBe(-300);
    expect(clampImageTranslation(50, 600, 1200, 1.5)).toBe(0);
  });
});
